// Optional, unretained by default. Decisions are cached without usage envelopes or fresh attempt identities.
import { z } from "../../shared/deps.ts";
import type { FixProposer, ProposerResponse, ReviewResponse } from "./types.ts";
import type { Finding } from "../audit/types.ts";
import type { ProposalContext } from "./context.ts";
import { contextWire } from "../../shared/prompt.ts";
import { ProposeRequestSchema, ContextSchema, UUID_PATTERN } from "../../shared/proposeRequest.ts";
import type { ProposeRequest } from "../../shared/proposeRequest.ts";
import { ProposeResponseSchema } from "../../shared/proposeResponse.ts";
import type { ProposeResponse } from "../../shared/proposeResponse.ts";
import { canonicalJson, sha256Text } from "../../shared/requestHash.ts";
import { canUseJev, JEV_NAME_RULES, typesafePlan } from "../../shared/typesafePlan.ts";
import type { JevPolicy } from "../../shared/typesafePlan.ts";
import { utf8ByteLength } from "../limits.ts";
const Origin = z.object({ callId: z.string().regex(UUID_PATTERN), attemptId: z.string().regex(UUID_PATTERN) }).strict();
export const JevCacheEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), value: z.string().max(125).nullable(), reason: z.string().max(500), origin: Origin }).strict(),
  z.object({ kind: z.literal("triage"), decision: z.enum(["pass", "reject", "route"]), reasons: z.array(z.string().max(100)).max(10), origin: Origin }).strict(),
]);
export type JevCacheEntry = z.infer<typeof JevCacheEntrySchema>;
export interface JevCache { get(key: string): Promise<JevCacheEntry | null>; put(key: string, entry: JevCacheEntry): Promise<void> }
export function createMemoryJevCache(): JevCache {
  const values = new Map<string, JevCacheEntry>();
  return { async get(key) { const entry = values.get(key); return entry === undefined ? null : JevCacheEntrySchema.parse(entry); }, async put(key, entry) { values.set(key, JevCacheEntrySchema.parse(entry)); } };
}
export interface JevOptions {
  readonly policy: JevPolicy; readonly experimental?: boolean; readonly runKey?: string; readonly cache: JevCache;
  readonly attemptId: (finding: Finding, number: number, method: "jev-choice" | "jev-triage") => Promise<string>;
  readonly invoke: (request: ProposeRequest) => Promise<{ httpStatus: number; body: unknown }>;
}
async function contextFor(context: ProposalContext, options: JevOptions, proposedValue?: string) {
  const value = ContextSchema.parse({ ...context, jevPolicyHash: await sha256Text(canonicalJson(options.policy)),
    ...(options.experimental === true ? { jevExperimental: true } : {}), ...(proposedValue === undefined ? {} : { proposedValue }) });
  if (utf8ByteLength(contextWire(value)) > 4096) throw new Error("context_exceeds_4096_utf8_bytes"); return value;
}
async function invoke(options: JevOptions, finding: Finding, context: Awaited<ReturnType<typeof contextFor>>, number: number, method: "jev-choice" | "jev-triage"): Promise<ProposeResponse | null> {
  const request = ProposeRequestSchema.parse({ attemptId: await options.attemptId(finding, number, method), proposer: method, model: options.policy.model,
    finding: { rule: finding.rule, ordinal: finding.ordinal, fingerprint: finding.fingerprint }, context, retryReasons: [], ...(options.runKey === undefined ? {} : { runKey: options.runKey }) });
  const raw = await options.invoke(request); if (raw.httpStatus === 401) return { kind: "error", code: "unauthorized" };
  const parsed = ProposeResponseSchema.safeParse(raw.body); if (!parsed.success) return null;
  const response = parsed.data;
  if ("usage" in response && response.usage !== undefined && (response.usage.attempt_id !== request.attemptId || response.usage.provider !== "typesafe" || response.usage.model !== options.policy.model)) return null;
  return response;
}
function fromError(response: ProposeResponse | null): ProposerResponse {
  if (response?.kind === "error") return response.code === "screened" ? { kind: "abstain", reason: "screened" } : { kind: "inconclusive", reason: response.code };
  if (response?.kind === "rejected") return { kind: "rejected", reasons: response.reasons };
  return { kind: "inconclusive", reason: "bad_response" };
}
export function createJevProposer(options: JevOptions): FixProposer {
  return { id: "jev-choice", mode: "live", requiresSafeContext: true, async propose(finding, context, attempt) {
    if (!JEV_NAME_RULES.some((rule) => rule === finding.rule)) return { kind: "abstain", reason: "not_applicable" };
    if (context.candidates.length === 0) return { kind: "abstain", reason: "no_candidates" };
    if (!canUseJev(options.policy, options.experimental)) return { kind: "abstain", reason: "jev_disabled_uncalibrated" };
    let selected; try { selected = await contextFor(context, options); } catch { return { kind: "abstain", reason: "thin_context" }; }
    const key = (await typesafePlan({ context: selected, proposer: "jev-choice" }, options.policy)).key;
    const cached = await options.cache.get(key);
    if (cached?.kind === "choice") return { ...(cached.value === null ? { kind: "abstain" as const, reason: cached.reason } : { kind: "proposal" as const, value: { ops: [{ op: "set_attr", fingerprint: finding.fingerprint, name: "aria-label", value: cached.value }] } }), cache: { key, originCallId: cached.origin.callId, originAttemptId: cached.origin.attemptId } };
    const response = await invoke(options, finding, selected, attempt.attempt, "jev-choice");
    if (response?.kind === "abstain") {
      await options.cache.put(key, { kind: "choice", value: null, reason: response.reason, origin: { callId: response.usage.call_id, attemptId: response.usage.attempt_id } }); return { kind: "abstain", reason: response.reason };
    }
    if (response?.kind !== "ops") return fromError(response);
    const op = response.ops[0];
    if (response.ops.length !== 1 || op?.op !== "set_attr" || op.name !== "aria-label" || op.fingerprint !== finding.fingerprint || !context.candidates.some((candidate) => candidate.value === op.value)) return { kind: "inconclusive", reason: "bad_response" };
    await options.cache.put(key, { kind: "choice", value: op.value, reason: "", origin: { callId: response.usage.call_id, attemptId: response.usage.attempt_id } }); return { kind: "proposal", value: { ops: response.ops } };
  } };
}
/** Can only filter a code-accepted content candidate. It never creates ops or upgrades a code decision. */
export function withJevTriage(base: FixProposer, options: JevOptions): FixProposer {
  return { ...base, id: `${base.id}+jev-triage`, mode: "live", async reviewAccepted(finding, context, ops, gate, number): Promise<ReviewResponse> {
    if (gate.accepted !== true || gate.state !== "checked") return { decision: "route", reasons: ["code_not_accepted_content"] };
    if (!canUseJev(options.policy, options.experimental)) return { decision: "route", reasons: ["jev_disabled_uncalibrated"] };
    const op = ops[0]; const value = op?.op === "set_attr" ? op.value : op?.op === "set_document_title" ? op.text : "";
    let selected; try { selected = await contextFor(context, options, value); } catch { return { decision: "route", reasons: ["thin_context"] }; }
    const key = (await typesafePlan({ context: selected, proposer: "jev-triage" }, options.policy)).key; const cached = await options.cache.get(key);
    if (cached?.kind === "triage") return { decision: cached.decision, reasons: cached.reasons, cache: { key, originCallId: cached.origin.callId, originAttemptId: cached.origin.attemptId } };
    const response = await invoke(options, finding, selected, number, "jev-triage");
    if (response?.kind !== "triage") return { decision: "inconclusive", reasons: [response?.kind === "error" ? response.code : "bad_response"] };
    await options.cache.put(key, { kind: "triage", decision: response.decision, reasons: response.reasons, origin: { callId: response.usage.call_id, attemptId: response.usage.attempt_id } }); return { decision: response.decision, reasons: response.reasons };
  } };
}
