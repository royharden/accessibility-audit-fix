// Pure edge orchestration. HTTP/JWT/secret acquisition happens in edge index.ts before this function.
// This unit imports only the shared closure, enabling Node tests against the same source copied to Deno.
import type { ProposeRequest } from "./proposeRequest.ts";
import type { ProposeResponse, Usage } from "./proposeResponse.ts";
import { ERROR_CODES } from "./proposeResponse.ts";
import { METHODS, isPinnedMethod } from "./providerConfig.ts";
import { contextWire, CONTEXT_BYTES } from "./prompt.ts";
import { requestHashes } from "./requestHash.ts";
import { screenText } from "./screen.ts";
import { isAbstain, parseProposal } from "./opsSchema.ts";
import { checkOpsForFinding } from "./ruleOps.ts";
import { checkProposalValues } from "./valueGates.ts";
import type { ProviderReply } from "./providers/anthropic.ts";
import { JEV_NAME_RULES, TriageDecisionSchema } from "./typesafePlan.ts";
import { bucketOf } from "./rules.ts";
export interface EdgeServices {
  readonly providerConfigured: boolean;
  hasEvalBudget(uid: string, runKey: string): Promise<boolean>;
  reserve(args: { p_user_id: string; p_scope: "demo" | "eval_run"; p_run_key: string | null; p_attempt_id: string; p_provider: string; p_model: string; p_proposer: string; p_rule_id: string; p_context_sha256: string; p_request_sha256: string }): Promise<{ call_id: string; claim: "new" | "pending" | "settled" }>;
  settle(id: string, status: "ok" | "abstain" | "schema_reject" | "unknown_charge", input: number | null, output: number | null): Promise<void>;
  usage(id: string): Promise<Usage>;
  call(request: ProposeRequest): Promise<ProviderReply>;
  /** Tests may allow a configured activation model without editing global constants. Production omits this seam. */
  readonly methodPinned?: (method: ProposeRequest["proposer"]) => boolean;
}
function rpcCode(error: unknown): ProposeResponse & { kind: "error" } {
  const message = error instanceof Error ? error.message : "";
  const code = ERROR_CODES.find((candidate) => message === candidate);
  return { kind: "error", code: code ?? "provider_error" };
}
export async function runEdgeProposal(request: ProposeRequest, uid: string, services: EdgeServices): Promise<ProposeResponse> {
  if (new TextEncoder().encode(contextWire(request.context)).byteLength > CONTEXT_BYTES) return { kind: "error", code: "payload_too_large" };
  if (request.proposer === "jev-choice" && (!JEV_NAME_RULES.some((rule) => rule === request.finding.rule) || request.context.candidates.length === 0)) return { kind: "error", code: "bad_request" };
  if (request.proposer === "jev-triage" && (bucketOf(request.finding.rule) !== "content" || request.context.proposedValue === undefined)) return { kind: "error", code: "bad_request" };
  const method = METHODS[request.proposer];
  if (request.model !== method.model || !(services.methodPinned ?? isPinnedMethod)(request.proposer) || !services.providerConfigured) return { kind: "error", code: "provider_not_configured" };
  const hashes = await requestHashes(uid, request); // Received pre-server-screen context; never a client-supplied binding hash.
  const screened = screenText(JSON.stringify(request.context));
  if (screened.flagged) return { kind: "error", code: "screened" };
  let claim: { call_id: string; claim: "new" | "pending" | "settled" };
  try {
    if (request.runKey !== undefined && !await services.hasEvalBudget(uid, request.runKey)) return { kind: "error", code: "budget_not_found" };
    claim = await services.reserve({ p_user_id: uid, p_scope: request.runKey === undefined ? "demo" : "eval_run", p_run_key: request.runKey ?? null,
      p_attempt_id: request.attemptId, p_provider: method.provider, p_model: request.model, p_proposer: request.proposer, p_rule_id: request.finding.rule,
      p_context_sha256: hashes.contextSha256, p_request_sha256: hashes.requestSha256 });
  } catch (error) { return rpcCode(error); }
  if (claim.claim !== "new") {
    let usage: Usage | undefined; try { usage = await services.usage(claim.call_id); } catch { /* No invented read-back. */ }
    return { kind: "error", code: claim.claim === "pending" ? "attempt_in_progress" : "attempt_already_settled", ...(usage === undefined ? {} : { usage }) };
  }
  let reply: ProviderReply;
  try { reply = await services.call(request); } catch { reply = { kind: "error", code: "provider_error", inputTokens: null, outputTokens: null }; }
  let result: { kind: "ops"; ops: NonNullable<ProposeResponse & { kind: "ops" }>["ops"] } | { kind: "abstain"; reason: string } | { kind: "rejected"; reasons: string[] } | { kind: "triage"; decision: "pass" | "reject" | "route"; reasons: string[] } | { kind: "error"; code: "provider_error" | "provider_timeout" | "rate_limited" };
  let status: "ok" | "abstain" | "schema_reject" | "unknown_charge";
  if (reply.kind === "error") { status = "unknown_charge"; result = { kind: "error", code: reply.code ?? "provider_error" }; }
  else if (request.proposer === "jev-triage") {
    const decision = TriageDecisionSchema.safeParse(reply.value); status = decision.success ? "ok" : "schema_reject";
    result = decision.success ? { kind: "triage", ...decision.data } : { kind: "rejected", reasons: ["invalid_triage_response"] };
  } else {
    const parsed = parseProposal(reply.value);
    if (!parsed.ok) { status = "schema_reject"; result = { kind: "rejected", reasons: [...parsed.reasons] }; }
    else if (isAbstain(parsed.value)) { status = "abstain"; result = { kind: "abstain", reason: parsed.value.abstain }; }
    else {
      const ops = parsed.value.ops; const matrix = checkOpsForFinding(request.finding, ops);
      const values = checkProposalValues(request.finding.rule, ops, { idCounts: request.context.ids === undefined ? undefined : Object.fromEntries(request.context.ids.map((item) => [item.id, item.count])), targetId: request.context.targetId,
        screenedSpans: screened.spans.map((span) => span.text) });
      const reasons = [...(matrix.ok ? [] : matrix.reasons), ...(values.ok ? [] : values.reasons),
        ...(ops.some((op) => JSON.stringify(op).includes("[screened]")) ? ["value_contains_screened_span"] : [])];
      status = reasons.length === 0 ? "ok" : "schema_reject";
      result = reasons.length === 0 ? { kind: "ops", ops } : { kind: "rejected", reasons: [...new Set(reasons)] };
    }
  }
  try { await services.settle(claim.call_id, status, reply.inputTokens, reply.outputTokens); return { ...result, usage: await services.usage(claim.call_id) }; }
  catch { return { kind: "error", code: "provider_error" }; } // Settlement/read-back uncertainty cannot become an accepted proposal.
}
