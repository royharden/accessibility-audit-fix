import type { FixProposer } from "./types.ts";
import type { Finding } from "../audit/types.ts";
import type { ProposeRequest } from "../../shared/proposeRequest.ts";
import { ProposeRequestSchema } from "../../shared/proposeRequest.ts";
import { ProposeResponseSchema } from "../../shared/proposeResponse.ts";
import type { MethodId } from "../../shared/providerConfig.ts";
import { METHODS } from "../../shared/providerConfig.ts";
export interface RemoteOptions {
  readonly proposer: MethodId; readonly runKey?: string;
  readonly attemptId: (finding: Finding, number: number) => Promise<string>;
  readonly invoke: (request: ProposeRequest) => Promise<{ httpStatus: number; body: unknown }>;
}
export function createRemoteProposer(options: RemoteOptions): FixProposer {
  return { id: options.proposer, mode: "live", requiresSafeContext: true, async propose(finding, context, attempt) {
    if (finding.ordinal === null || finding.fingerprint === null) return { kind: "abstain", reason: finding.unmappedReason ?? "unmapped" };
    const request = ProposeRequestSchema.safeParse({ attemptId: await options.attemptId(finding, attempt.attempt), proposer: options.proposer, model: METHODS[options.proposer].model,
      finding: { rule: finding.rule, ordinal: finding.ordinal, fingerprint: finding.fingerprint }, context,
      retryReasons: attempt.reasons.slice(0, 10).map((reason) => reason.slice(0, 200)), ...(options.runKey === undefined ? {} : { runKey: options.runKey }) });
    if (!request.success) return { kind: "inconclusive", reason: "bad_request" };
    let response; try { response = await options.invoke(request.data); } catch { return { kind: "inconclusive", reason: "provider_error" }; }
    if (response.httpStatus === 401) return { kind: "inconclusive", reason: "unauthorized" };
    const parsed = ProposeResponseSchema.safeParse(response.body);
    if (!parsed.success) return { kind: "inconclusive", reason: "bad_response" };
    const value = parsed.data;
    if ("usage" in value && value.usage !== undefined && (value.usage.attempt_id !== request.data.attemptId || value.usage.provider !== METHODS[options.proposer].provider || value.usage.model !== request.data.model)) return { kind: "inconclusive", reason: "bad_response" };
    if (value.kind === "error") return value.code === "screened" ? { kind: "abstain", reason: "screened" } : { kind: "inconclusive", reason: value.code };
    if (value.kind === "abstain") return { kind: "abstain", reason: value.reason };
    if (value.kind === "rejected") return { kind: "rejected", reasons: value.reasons };
    return { kind: "proposal", value: { ops: value.ops } };
  } };
}
