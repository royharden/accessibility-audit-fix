import { z } from "./deps.ts";
import { OpSchema, parseProposal } from "./opsSchema.ts";
import { UUID_PATTERN } from "./proposeRequest.ts";
export const CALL_STATUSES = ["reserved", "ok", "abstain", "schema_reject", "screened", "error", "timeout", "unknown_charge"] as const;
const integer = z.number().int().nonnegative();
export const UsageSchema = z.object({ call_id: z.string().regex(UUID_PATTERN), attempt_id: z.string().regex(UUID_PATTERN), status: z.enum(CALL_STATUSES),
  input_tokens: integer.nullable(), output_tokens: integer.nullable(), reserved_usd_micros: integer, cost_usd_micros: integer.nullable(), latency_ms: integer.nullable(),
  provider: z.string().min(1), model: z.string().min(1) }).strict();
export type Usage = z.infer<typeof UsageSchema>;
export const ERROR_CODES = ["provider_timeout", "provider_error", "rate_limited", "attempt_in_progress", "screened", "budget_exceeded", "budget_not_found",
  "provider_not_configured", "unauthorized", "bad_request", "payload_too_large", "attempt_conflict", "attempt_already_settled"] as const;
export const ProposeResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ops"), ops: z.array(OpSchema).min(1).max(2), usage: UsageSchema }).strict(),
  z.object({ kind: z.literal("abstain"), reason: z.string().min(1).max(500), usage: UsageSchema }).strict(),
  z.object({ kind: z.literal("rejected"), reasons: z.array(z.string().min(1).max(300)).min(1).max(50), usage: UsageSchema }).strict(),
  z.object({ kind: z.literal("error"), code: z.enum(ERROR_CODES), usage: UsageSchema.optional() }).strict(),
  z.object({ kind: z.literal("triage"), decision: z.enum(["pass", "reject", "route"]), reasons: z.array(z.string().min(1).max(100)).max(10), usage: UsageSchema }).strict(),
]).superRefine((response, ctx) => {
  if (response.kind === "ops") { const result = parseProposal({ ops: response.ops }); if (!result.ok) for (const reason of result.reasons) ctx.addIssue({ code: "custom", message: reason }); }
});
export type ProposeResponse = z.infer<typeof ProposeResponseSchema>;
/** Exact llm_calls read-back columns; timestamps are server fields, never reconstructed from usage. */
export const LlmCallSchema = z.object({ id: z.string().regex(UUID_PATTERN), attempt_id: z.string().regex(UUID_PATTERN), user_id: z.string().regex(UUID_PATTERN),
  provider: z.string(), model: z.string(), proposer: z.string(), rule_id: z.string(), context_sha256: z.string().regex(/^[a-f0-9]{64}$/), request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  budget_scope: z.enum(["demo", "eval_run"]), budget_period_key: z.string(), status: z.enum(CALL_STATUSES), input_tokens: integer.nullable(), output_tokens: integer.nullable(),
  reserved_usd_micros: integer, cost_usd_micros: integer.nullable(), latency_ms: integer.nullable(), created_at: z.string().nullable(), settled_at: z.string().nullable() }).strict();
export type LlmCall = z.infer<typeof LlmCallSchema>;
export function usageFromCall(call: LlmCall): Usage {
  return UsageSchema.parse({ call_id: call.id, attempt_id: call.attempt_id, status: call.status, input_tokens: call.input_tokens, output_tokens: call.output_tokens,
    reserved_usd_micros: call.reserved_usd_micros, cost_usd_micros: call.cost_usd_micros, latency_ms: call.latency_ms, provider: call.provider, model: call.model });
}
