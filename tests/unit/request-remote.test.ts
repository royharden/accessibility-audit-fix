// what_bug_this_catches: client/server request-binding drift, unknown response codes silently accepted, stale
// usage binding, and server-side value/schema rejection losing its reasons or entering gate denominators.
// No network/provider calls. Written, never run.
import { describe, expect, it } from "vitest";
import { buildContext } from "../../src/core/proposers/context.ts";
import { parsePage } from "../../src/core/html/parse.ts";
import type { Finding } from "../../src/core/audit/types.ts";
import { createRemoteProposer } from "../../src/core/proposers/remote.ts";
import { ProposeRequestSchema } from "../../src/shared/proposeRequest.ts";
import { ERROR_CODES, ProposeResponseSchema } from "../../src/shared/proposeResponse.ts";
import { canonicalJson, requestHashes, sha256Text } from "../../src/shared/requestHash.ts";
import { MODEL_A } from "../../src/shared/providerConfig.ts";
import { runFix } from "../../src/core/loop/runFix.ts";
import { buildRenderCopy } from "../../src/core/html/renderCopy.ts";

const attemptId = "22222222-2222-8222-8222-222222222222";
const target: Finding = { rule: "image-alt", ordinal: 0, fingerprint: "image-alt:0", impact: "serious", cite: null, unmappedReason: null, summary: null, contrast: null };
const page = parsePage("<img>"); const context = buildContext(page, target).context;
const request = () => ProposeRequestSchema.parse({ attemptId, proposer: "llm-A", model: MODEL_A, finding: { rule: "image-alt", ordinal: 0, fingerprint: "image-alt:0" }, context, retryReasons: [], runKey: "unit-run" });
const usage = { call_id: "33333333-3333-8333-8333-333333333333", attempt_id: attemptId, status: "ok", input_tokens: 100, output_tokens: 20,
  reserved_usd_micros: 1000, cost_usd_micros: 100, latency_ms: 15, provider: "anthropic", model: MODEL_A };
describe("shared canonical hashes", () => {
  it("uses stable JSON and the SHA256 known vector", async () => {
    expect(canonicalJson({ b: 2, a: [true, "x"] })).toBe('{"a":[true,"x"],"b":2}');
    expect(await sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(() => canonicalJson({ bad: undefined })).toThrow();
  });
  it("binds uid, method/model, finding, context, retry reasons and run key; excludes attempt id", async () => {
    const base = request(); const original = await requestHashes("user-a", base);
    const alternatives = [ { ...base, model: "different" }, { ...base, proposer: "llm-B" as const }, { ...base, retryReasons: ["different"] },
      { ...base, runKey: "different" }, { ...base, finding: { ...base.finding, fingerprint: "image-alt:1" } }, { ...base, context: { ...base.context, summary: "different" } } ];
    for (const value of alternatives) expect((await requestHashes("user-a", value)).requestSha256).not.toBe(original.requestSha256);
    expect((await requestHashes("user-b", base)).requestSha256).not.toBe(original.requestSha256);
    expect((await requestHashes("user-a", { ...base, attemptId: "44444444-4444-8444-8444-444444444444" })).requestSha256).toBe(original.requestSha256);
  });
});
describe("remote response mapping", () => {
  for (const code of ERROR_CODES) it(`maps ${code} to its one explicit client state`, async () => {
    const remote = createRemoteProposer({ proposer: "llm-A", runKey: "unit-run", attemptId: async () => attemptId, invoke: async () => ({ httpStatus: 200, body: { kind: "error", code } }) });
    expect(await remote.propose(target, context, { attempt: 1, reasons: [] })).toEqual({ kind: code === "screened" ? "abstain" : "inconclusive", reason: code });
  });
  it("maps gateway401 before zod and unknown or wrongly-bound responses to bad_response", async () => {
    const invoke = (httpStatus: number, body: unknown) => createRemoteProposer({ proposer: "llm-A", attemptId: async () => attemptId, invoke: async () => ({ httpStatus, body }) });
    expect(await invoke(401, "gateway HTML").propose(target, context, { attempt: 1, reasons: [] })).toEqual({ kind: "inconclusive", reason: "unauthorized" });
    expect(await invoke(200, { kind: "error", code: "future_unknown" }).propose(target, context, { attempt: 1, reasons: [] })).toEqual({ kind: "inconclusive", reason: "bad_response" });
    expect(await invoke(200, { kind: "abstain", reason: "thin", usage: { ...usage, attempt_id: "44444444-4444-8444-8444-444444444444" } }).propose(target, context, { attempt: 1, reasons: [] })).toEqual({ kind: "inconclusive", reason: "bad_response" });
    expect(ProposeResponseSchema.safeParse({ kind: "error", code: "bad_response" }).success).toBe(false); // local parse failure, never a guessed server code
  });
  it("keeps edge rejection outside gate columns and retries with its machine reasons", async () => {
    let count = 0;
    const remote = createRemoteProposer({ proposer: "llm-A", runKey: "unit-run", attemptId: async () => attemptId, invoke: async (input) => {
      count++; if (count === 1) return { httpStatus: 200, body: { kind: "rejected", reasons: ["value_generic"], usage: { ...usage, status: "schema_reject" } } };
      expect(input.retryReasons).toEqual(["value_generic"]);
      return { httpStatus: 200, body: { kind: "ops", ops: [{ op: "set_attr", fingerprint: "image-alt:0", name: "alt", value: "Mountain lake" }], usage } };
    } });
    const baseline = { status: "complete" as const, findings: [target], incomplete: [], engine: "jsdom" as const, profile: "unit", axeVersion: "unit", notMeasured: ["label-content-name-mismatch"], errors: [] };
    const fix = await runFix({ page, finding: target, baseline, proposer: remote, engine: { id: "jsdom", audit: async () => ({ ...baseline, findings: [] }) }, render: (source, insertedTitleStart) => buildRenderCopy(source, { insertedTitleStart }).html });
    expect(fix.firstPass.stage).toBe("schema"); expect(fix.firstPass.variants).toBeUndefined(); expect(fix.final.state).toBe("checked"); expect(count).toBe(2);
  });
});
