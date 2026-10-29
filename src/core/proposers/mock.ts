import type { FixProposer } from "./types.ts";

export type ReplayAttempt = { readonly kind: "ops"; readonly ops: readonly unknown[] } |
  { readonly kind: "abstain"; readonly reason: string } | { readonly kind: "timeout" };
export interface ReplayScript { readonly fingerprint: string; readonly attempts: readonly ReplayAttempt[] }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** Validate replay envelopes only; operation JSON stays unknown until runFix's canonical schema validation. */
export function parseReplayScript(value: unknown): ReplayScript {
  if (!record(value) || typeof value["fingerprint"] !== "string" || !Array.isArray(value["attempts"])) throw new Error("invalid_replay_script");
  const attempts: ReplayAttempt[] = value["attempts"].map((item: unknown) => {
    if (!record(item)) throw new Error("invalid_replay_attempt");
    if (item["kind"] === "ops" && Array.isArray(item["ops"])) return { kind: "ops", ops: item["ops"] };
    if (item["kind"] === "abstain" && typeof item["reason"] === "string") return { kind: "abstain", reason: item["reason"] };
    if (item["kind"] === "timeout") return { kind: "timeout" };
    throw new Error("invalid_replay_attempt");
  });
  return { fingerprint: value["fingerprint"], attempts };
}
export function createMockProposer(scripts: readonly ReplayScript[]): FixProposer {
  const byFingerprint = new Map(scripts.map((s) => [s.fingerprint, s]));
  if (byFingerprint.size !== scripts.length) throw new Error("duplicate_replay_fingerprint");
  return { id: "mock", mode: "mock", async propose(finding, _context, attempt) {
    const script = finding.fingerprint === null ? undefined : byFingerprint.get(finding.fingerprint);
    const response = script?.attempts[Math.min(attempt.attempt - 1, script.attempts.length - 1)];
    if (response === undefined) return { kind: "abstain", reason: "no_scripted_proposal" };
    if (response.kind === "timeout") return { kind: "inconclusive", reason: "provider_timeout" };
    if (response.kind === "abstain") return { kind: "abstain", reason: response.reason };
    return { kind: "proposal", value: { ops: response.ops } };
  } };
}
