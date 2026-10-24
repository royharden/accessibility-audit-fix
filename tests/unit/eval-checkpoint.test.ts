// what_bug_this_catches: resumed/lost settled attempts paying twice, user/request collision, stale in-progress
// polling loops, invented ledger columns, and exceeding the two-call CLI ceiling. All dependencies are in-memory.
import { describe, expect, it } from "vitest";
import { createCheckpointTransport, deterministicAttemptId } from "../../src/node/evalCheckpoint.ts";
import type { CheckpointEntry } from "../../src/node/evalCheckpoint.ts";
import type { OperatorSession } from "../../src/node/operatorSession.ts";
import { requestHashes } from "../../src/shared/requestHash.ts";
import { LlmCallSchema, usageFromCall } from "../../src/shared/proposeResponse.ts";
import { ProposeRequestSchema } from "../../src/shared/proposeRequest.ts";
import { MODEL_A } from "../../src/shared/providerConfig.ts";
import { buildContext } from "../../src/core/proposers/context.ts";
import { parsePage } from "../../src/core/html/parse.ts";

const uid = "11111111-1111-8111-8111-111111111111"; const id = "22222222-2222-8222-8222-222222222222";
const finding = { rule: "image-alt" as const, ordinal: 0, fingerprint: "image-alt:0" as const, impact: null, cite: null, unmappedReason: null, summary: null, contrast: null };
function request(attemptId = id) { return ProposeRequestSchema.parse({ attemptId, proposer: "llm-A", model: MODEL_A, finding: { rule: finding.rule, ordinal: 0, fingerprint: finding.fingerprint }, context: buildContext(parsePage("<img>"), finding).context, retryReasons: [], runKey: "unit-run" }); }
function memory() {
  const entries = new Map<string, CheckpointEntry>(); const calls: unknown[] = [];
  return { entries, calls, checkpoint: { get: (attemptId: string) => entries.get(attemptId), write: async (entry: CheckpointEntry) => { entries.set(entry.attemptId, entry); } },
    ledger: { record: async (raw: unknown) => { const call = LlmCallSchema.parse(raw); calls.push(call); return call; } } };
}
async function row(status: "ok" | "reserved" = "ok") {
  const hashes = await requestHashes(uid, request());
  return LlmCallSchema.parse({ id: "33333333-3333-8333-8333-333333333333", attempt_id: id, user_id: uid, provider: "anthropic", model: MODEL_A, proposer: "llm-A", rule_id: "image-alt", ...{ context_sha256: hashes.contextSha256, request_sha256: hashes.requestSha256 },
    budget_scope: "eval_run", budget_period_key: "unit-run", status, input_tokens: status === "reserved" ? null : 100, output_tokens: status === "reserved" ? null : 10,
    reserved_usd_micros: 1000, cost_usd_micros: status === "reserved" ? null : 100, latency_ms: status === "reserved" ? null : 50,
    created_at: "2026-10-24T00:00:00Z", settled_at: status === "reserved" ? null : "2026-10-24T00:00:01Z" });
}
describe("checkpoint and deterministic attempt identity", () => {
  it("pins all execution identity fields including uid and attempt", async () => {
    const identity = { uid, runKey: "unit-run", sourceSha256: "a".repeat(64), engineProfile: "unit-profile", fingerprint: "image-alt:0", proposer: "llm-A", model: MODEL_A, attempt: 1 };
    const first = await deterministicAttemptId(identity); expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(await deterministicAttemptId(identity)).toBe(first);
    for (const changed of [{ uid: "other" }, { runKey: "other" }, { sourceSha256: "b".repeat(64) }, { engineProfile: "other" }, { fingerprint: "image-alt:1" }, { proposer: "llm-B" }, { model: "other" }, { attempt: 2 }]) expect(await deterministicAttemptId({ ...identity, ...changed })).not.toBe(first);
  });
  it("lost settled response stays inconclusive and is never invoked again on resume", async () => {
    const m = memory(); const call = await row(); let invokes = 0;
    const session: OperatorSession = { userId: uid, invoke: async () => { invokes++; throw new Error("lost"); }, readOwnCall: async () => call, close: async () => {} };
    const transport = createCheckpointTransport({ session, checkpoint: m.checkpoint, ledger: m.ledger, wait: async () => {} });
    expect((await transport.invoke(request())).body).toMatchObject({ kind: "error", code: "attempt_already_settled", usage: { cost_usd_micros: 100 } });
    expect((await transport.invoke(request())).body).toMatchObject({ kind: "error", code: "attempt_already_settled" }); expect(invokes).toBe(1);
    expect(m.calls).toContainEqual(call);
  });
  it("in-progress resume uses one bounded wait and request-hash conflict never invokes", async () => {
    const m = memory(); const call = await row("reserved"); let waits = 0; let reads = 0; let invokes = 0;
    m.entries.set(id, { attemptId: id, requestSha256: call.request_sha256, phase: "started", response: null });
    const session: OperatorSession = { userId: uid, invoke: async () => { invokes++; return { httpStatus: 200, body: {} }; }, readOwnCall: async () => { reads++; return call; }, close: async () => {} };
    const transport = createCheckpointTransport({ session, checkpoint: m.checkpoint, ledger: m.ledger, wait: async (ms) => { expect(ms).toBe(500); waits++; } });
    expect((await transport.invoke(request())).body).toMatchObject({ kind: "error", code: "attempt_in_progress" }); expect(waits).toBe(1); expect(reads).toBeLessThanOrEqual(3); expect(invokes).toBe(0);
    expect((await transport.invoke({ ...request(), retryReasons: ["changed"] })).body).toMatchObject({ kind: "error", code: "attempt_conflict" }); expect(invokes).toBe(0);
  });
  it("cached validated completion is reused and budget_exceeded stops future spending", async () => {
    const m = memory(); let invokes = 0;
    const session: OperatorSession = { userId: uid, invoke: async () => { invokes++; return { httpStatus: 200, body: { kind: "error", code: "budget_exceeded" } }; }, readOwnCall: async () => null, close: async () => {} };
    const transport = createCheckpointTransport({ session, checkpoint: m.checkpoint, ledger: m.ledger });
    await transport.invoke(request()); expect(transport.isStopped()).toBe(true);
    await transport.invoke(request("44444444-4444-8444-8444-444444444444")); await transport.invoke(request()); expect(invokes).toBe(1);
  });
  it("accepts only exact read-back columns and never adds timestamps/token data from usage", async () => {
    const call = await row(); const usage = usageFromCall(call);
    expect(usage).not.toHaveProperty("created_at"); expect(usage).not.toHaveProperty("settled_at");
    expect(LlmCallSchema.safeParse(usage).success).toBe(false);
    const reserved = await row("reserved"); expect(reserved).toMatchObject({ input_tokens: null, output_tokens: null, cost_usd_micros: null, latency_ms: null, settled_at: null });
  });
  it("allows no more than two fresh invocations concurrently", async () => {
    const m = memory(); let started = 0; let ready!: () => void; let release!: () => void;
    const twoStarted = new Promise<void>((resolve) => { ready = resolve; }); const held = new Promise<void>((resolve) => { release = resolve; });
    const session: OperatorSession = { userId: uid, invoke: async () => { started++; if (started === 2) ready(); await held; return { httpStatus: 200, body: { kind: "error", code: "provider_not_configured" } }; }, readOwnCall: async () => null, close: async () => {} };
    const transport = createCheckpointTransport({ session, checkpoint: m.checkpoint, ledger: m.ledger });
    const a = transport.invoke(request()); const b = transport.invoke(request("44444444-4444-8444-8444-444444444444")); await twoStarted;
    expect((await transport.invoke(request("55555555-5555-8555-8555-555555555555"))).body).toMatchObject({ kind: "error", code: "rate_limited" });
    expect(started).toBe(2); release(); await Promise.all([a, b]);
  });
});
