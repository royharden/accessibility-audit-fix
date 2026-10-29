// what_bug_this_catches: endpoint escape, incompatible token fields, invented Jev values/confidence,
// candidate-order cache misses, and a cache hit creating a fresh billed attempt. Mocked HTTP only; not run.
import { describe, expect, it } from "vitest";
import { compatibleEndpoint, callOpenaiCompatible } from "../../src/shared/providers/openaiCompatible.ts";
import { callTypesafe } from "../../src/shared/providers/typesafe.ts";
import type { JsonProviderFetch } from "../../src/shared/providers/http.ts";
import { JevPolicySchema, canUseJev, typesafePlan, NOUL_QUESTIONS } from "../../src/shared/typesafePlan.ts";
import declaration from "../../config/jev-thresholds.json" with { type: "json" };
import { ProposeRequestSchema } from "../../src/shared/proposeRequest.ts";
import { parsePage } from "../../src/core/html/parse.ts";
import { buildContext } from "../../src/core/proposers/context.ts";
import { createJevProposer, createMemoryJevCache, withJevTriage } from "../../src/core/proposers/jev.ts";
import type { Finding } from "../../src/core/audit/types.ts";
import { gateResult } from "../../src/core/gate/reasons.ts";
const finding: Finding = { rule: "button-name", ordinal: 0, fingerprint: "button-name:0", impact: "serious", cite: null, unmappedReason: null, summary: null, contrast: null };
const context = { ...buildContext(parsePage('<button title="Save document"></button>'), finding).context, candidates: [{ source: "title" as const, value: "Save document" }, { source: "value" as const, value: "Save changes" }] };
// Synthetic thresholds exercise branches; they are not calibration or retention evidence.
const policy = JevPolicySchema.parse({ ...declaration, enabled: true, devSelected: true, retained: true, heldoutWin: true, choiceMinConfidence: 0.8, routeAt: 0.5, rejectAt: 0.9 });
const attemptId = "22222222-2222-8222-8222-222222222222";
const usage = { call_id: "33333333-3333-8333-8333-333333333333", attempt_id: attemptId, status: "ok", input_tokens: 10, output_tokens: 5, reserved_usd_micros: 100, cost_usd_micros: 10, latency_ms: 1, provider: "typesafe", model: "jev-1.13.0" };
const request = (proposer: "jev-choice" | "jev-triage" = "jev-choice") => ProposeRequestSchema.parse({ attemptId, proposer, model: policy.model, finding: { rule: finding.rule, ordinal: 0, fingerprint: finding.fingerprint }, context, retryReasons: [] });
function reply(value: unknown): ReturnType<JsonProviderFetch> { return Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } })); }

describe("bounded provider B contract", () => {
  it("allows only the exact HTTPS base and makes one no-redirect request with the completion cap", async () => {
    for (const base of ["http://api.openai.com/v1", "https://api.openai.com.evil.test/v1", "https://user@api.openai.com/v1", "https://api.openai.com/v1?x=1", "https://api.openai.com/private"]) expect(() => compatibleEndpoint(base)).toThrow();
    let count = 0;
    const result = await callOpenaiCompatible("synthetic", "https://api.openai.com/v1", { model: "synthetic-unit-model", system: "system", prompt: "data", signal: new AbortController().signal }, async (url, options) => {
      count++; expect(url).toBe("https://api.openai.com/v1/chat/completions"); expect(options.redirect).toBe("error");
      const body = JSON.parse(options.body); expect(body.max_completion_tokens).toBe(1024); expect(body.max_tokens).toBeUndefined();
      return reply({ choices: [{ message: { content: '{"abstain":"no context"}' } }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    });
    expect(count).toBe(1); expect(result).toMatchObject({ kind: "ok", inputTokens: 9, outputTokens: 3 });
  });
  it("does not trust usage beyond the reserved output bound", async () => {
    const result = await callOpenaiCompatible("synthetic", "https://api.openai.com/v1", { model: "synthetic", system: "", prompt: "", signal: new AbortController().signal }, async () => reply({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1025 } }));
    expect(result).toMatchObject({ kind: "error", inputTokens: null, outputTokens: null });
  });
});
describe("Jev typed decisions and cache", () => {
  it("keeps the shipped policy disabled even in experimental mode; options/key are shuffle-stable", async () => {
    expect(canUseJev(JevPolicySchema.parse(declaration), true)).toBe(false);
    const first = await typesafePlan(request(), policy); const second = await typesafePlan({ ...request(), context: { ...context, candidates: [...context.candidates].reverse() } }, policy);
    expect(first.key).toBe(second.key); expect(first.choices).toEqual(second.choices); expect(JSON.stringify(first.body)).toContain('"none"');
    expect((await typesafePlan(request(), { ...policy, version: "changed" })).key).not.toBe(first.key);
  });
  it("selects only an existing candidate, supports none, and rejects invented choice ids", async () => {
    const plan = await typesafePlan(request(), policy); const choice = plan.choices[0]!;
    const answer = async (id: string) => callTypesafe("synthetic", request(), policy, new AbortController().signal, async (_url, options) => {
      expect(options.redirect).toBe("error"); expect(JSON.parse(options.body).model).toBe("jev-1.13.0");
      return reply({ answers: { name: { type: "choice", choice: id, confidence: 0.95, probabilities: { [id]: 0.95 } } }, usage: { input_tokens: 10, output_tokens: 5 } });
    });
    expect(await answer(choice.id)).toMatchObject({ kind: "ok", value: { ops: [{ value: choice.value }] } });
    expect(await answer("none")).toMatchObject({ kind: "ok", value: { abstain: "jev_none" } });
    expect(await answer("invented")).toMatchObject({ kind: "ok", value: { invalid_choice_response: true } });
  });
  it("uses Noul.noul without inventing a confidence field", async () => {
    const result = await callTypesafe("synthetic", request("jev-triage"), policy, new AbortController().signal, async () => reply({ answers: Object.fromEntries(Object.keys(NOUL_QUESTIONS).map((id) => [id, { type: "noul", noul: id === "name_is_generic" ? 0.95 : 0.1 }])), usage: { input_tokens: 10, output_tokens: 5 } }));
    expect(result).toMatchObject({ kind: "ok", value: { decision: "reject", reasons: ["jev:name_is_generic"] } });
  });
  it("never allocates an attempt or invokes transport on a decision-cache hit, empty candidates or inapplicable rule", async () => {
    let attempts = 0; let calls = 0;
    const proposer = createJevProposer({ policy, cache: createMemoryJevCache(), attemptId: async () => { attempts++; return attemptId; }, invoke: async () => { calls++; return { httpStatus: 200, body: { kind: "ops", ops: [{ op: "set_attr", fingerprint: finding.fingerprint, name: "aria-label", value: "Save document" }], usage } }; } });
    expect((await proposer.propose(finding, context, { attempt: 1, reasons: [] })).kind).toBe("proposal");
    const hit = await proposer.propose(finding, context, { attempt: 2, reasons: [] });
    expect(hit).toMatchObject({ kind: "proposal", cache: { originCallId: usage.call_id, originAttemptId: attemptId } });
    expect("usage" in hit).toBe(false); expect(attempts).toBe(1); expect(calls).toBe(1);
    await proposer.propose(finding, { ...context, candidates: [] }, { attempt: 1, reasons: [] });
    await proposer.propose({ ...finding, rule: "image-alt" }, context, { attempt: 1, reasons: [] }); expect(calls).toBe(1);
  });
  it("refuses to review a code rejection or mechanical verification", async () => {
    let calls = 0; const base = { id: "unit", mode: "mock" as const, propose: async () => ({ kind: "abstain" as const, reason: "unit" }) };
    const proposer = withJevTriage(base, { policy, cache: createMemoryJevCache(), attemptId: async () => attemptId, invoke: async () => { calls++; throw new Error("must not call"); } });
    for (const gate of [gateResult("strict", "rejected", ["unit"]), gateResult("strict", "verified", [])]) expect((await proposer.reviewAccepted!(finding, context, [], gate, 1)).decision).toBe("route");
    expect(calls).toBe(0);
  });
});

// Scripted code-gate evidence, not a measured browser/model result.
import { runFix } from "../../src/core/loop/runFix.ts";
import { buildRenderCopy } from "../../src/core/html/renderCopy.ts";
import { createMockProposer } from "../../src/core/proposers/mock.ts";
import type { AuditResult } from "../../src/core/audit/types.ts";
import { runEdgeProposal } from "../../src/shared/edgeFlow.ts";
import type { EdgeServices } from "../../src/shared/edgeFlow.ts";
it("retains the pre-Noul checked gate while a Noul route blocks the effective accepted result", async () => {
  const image: Finding = { ...finding, rule: "image-alt", fingerprint: "image-alt:0" };
  const baseline: AuditResult = { status: "complete", findings: [image], incomplete: [], engine: "jsdom", profile: "scripted-unit", axeVersion: "scripted-unit", notMeasured: ["label-content-name-mismatch"], errors: [] };
  const base = createMockProposer([{ fingerprint: "image-alt:0", attempts: [{ kind: "ops", ops: [{ op: "set_attr", fingerprint: "image-alt:0", name: "alt", value: "Mountain lake" }] }] }]);
  let reviewed = 0;
  const result = await runFix({ page: parsePage("<img>"), finding: image, baseline, engine: { id: "jsdom", audit: async () => ({ ...baseline, findings: [] }) }, render: (source) => buildRenderCopy(source).html,
    proposer: { ...base, reviewAccepted: async () => { reviewed++; return { decision: "route", reasons: ["jev:synthetic-review"] }; } } });
  expect(reviewed).toBe(1); expect(result.firstPass.codeGate).toMatchObject({ state: "checked", accepted: true });
  expect(result.final.gate).toMatchObject({ state: "needs_human", accepted: null }); expect(result.firstPass.variants?.targetOnly.accepted).toBe(true);
});
it("reserves and settles typed triage on the same eval budget route, never returning ops", async () => {
  const events: string[] = []; const input = request("jev-triage"); input.runKey = "unit-run"; input.context.proposedValue = "Save document";
  const services: EdgeServices = { providerConfigured: true, methodPinned: () => true,
    async hasEvalBudget() { events.push("grant"); return true; },
    async reserve(args) { events.push("reserve"); expect(args.p_scope).toBe("eval_run"); expect(args.p_run_key).toBe("unit-run"); expect(args.p_provider).toBe("typesafe"); return { call_id: usage.call_id, claim: "new" }; },
    async call() { events.push("provider"); return { kind: "ok", value: { decision: "route", reasons: ["jev:name_is_generic"] }, inputTokens: 10, outputTokens: 5 }; },
    async settle(_id, status) { events.push("settle"); expect(status).toBe("ok"); }, async usage() { events.push("usage"); return usage; } };
  const response = await runEdgeProposal(input, "synthetic-user", services);
  expect(response).toMatchObject({ kind: "triage", decision: "route", usage }); expect("ops" in response).toBe(false);
  expect(events).toEqual(["grant", "reserve", "provider", "settle", "usage"]);
});
