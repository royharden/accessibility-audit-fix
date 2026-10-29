// what_bug_this_catches: retry loops exceeding three attempts, malformed mock ops bypassing schema gates,
// source/fingerprint drift, input caps counting characters, proposal truncation dropping baseline findings,
// or schema rejection being counted as a measured gate result. Written, not run.
import { describe, expect, it } from "vitest";
import type { AuditResult, Finding } from "../../src/core/audit/types.ts";
import { formatFingerprint } from "../../src/core/findings/fingerprint.ts";
import { parsePage } from "../../src/core/html/parse.ts";
import { buildRenderCopy } from "../../src/core/html/renderCopy.ts";
import { createMockProposer } from "../../src/core/proposers/mock.ts";
import { runFix } from "../../src/core/loop/runFix.ts";
import { runPage } from "../../src/core/loop/runPage.ts";
import { buildJsonReport } from "../../src/core/report/json.ts";
import { combineFixes } from "../../src/core/gate/combine.ts";

function finding(rule: string, ordinal: number): Finding { return { rule, ordinal, fingerprint: formatFingerprint(rule, ordinal), impact: "serious", cite: { file: "p.html", line: 1, col: 1 }, unmappedReason: null, summary: null, contrast: null }; }
function audit(findings: readonly Finding[] = []): AuditResult { return { status: "complete", findings, incomplete: [], engine: "jsdom", axeVersion: "scripted-unit", profile: "scripted-unit", notMeasured: ["color-contrast", "label-content-name-mismatch"], errors: [] }; }
describe("proposal loop", () => {
  it("retries rejected proposals with reasons, retaining first/final and accepting a validated repair", async () => {
    const page = parsePage('<img>'); const target = finding("image-alt", 0);
    const proposer = createMockProposer([{ fingerprint: "image-alt:0", attempts: [
      { kind: "ops", ops: [{ op: "delete_element", fingerprint: "image-alt:0" }] },
      { kind: "ops", ops: [{ op: "set_attr", fingerprint: "image-alt:0", name: "alt", value: "Mountain lake" }] },
    ] }]);
    const result = await runFix({ page, finding: target, baseline: audit([target]), proposer,
      engine: { id: "jsdom", audit: async () => audit() }, render: (text, insertedTitleStart) => buildRenderCopy(text, { insertedTitleStart }).html });
    expect(result.attempts).toHaveLength(2); expect(result.firstPass.stage).toBe("schema");
    expect(result.firstPass.variants).toBeUndefined(); expect(result.final.state).toBe("checked");
    expect(result.final.applied?.text).toBe('<img alt="Mountain lake">');
  });
  it("caps repeated rejection at three and stops timeout as inconclusive", async () => {
    const page = parsePage("<img>"); const target = finding("image-alt", 0);
    const base = { page, finding: target, baseline: audit([target]), engine: { id: "jsdom" as const, audit: async () => audit() }, render: (text: string) => buildRenderCopy(text).html };
    const rejected = await runFix({ ...base, maxAttempts: 100, proposer: createMockProposer([{ fingerprint: "image-alt:0", attempts: [{ kind: "ops", ops: [{ op: "set_attr", fingerprint: "image-alt:9", name: "alt", value: "Mountain lake" }] }] }]) });
    expect(rejected.attempts).toHaveLength(3); expect(rejected.final.reasons).toContain("op_fingerprint_mismatch");
    const timeout = await runFix({ ...base, proposer: createMockProposer([{ fingerprint: "image-alt:0", attempts: [{ kind: "timeout" }] }]) });
    expect(timeout.attempts).toHaveLength(1); expect(timeout.final.state).toBe("inconclusive");
  });
  it("passes bounded machine reasons to the next attempt", async () => {
    const target = finding("image-alt", 0);
    const recorded: string[][] = [];
    const result = await runFix({ page: parsePage("<img>"), finding: target, baseline: audit([target]), render: (text) => buildRenderCopy(text).html,
      engine: { id: "jsdom", audit: async () => audit() }, proposer: { id: "capture", mode: "mock", async propose(_finding, _context, attempt) {
        recorded.push([...attempt.reasons]);
        return attempt.attempt === 1 ? { kind: "proposal", value: { ops: [{ op: "delete_element", fingerprint: "image-alt:0" }] } } : { kind: "abstain", reason: "no_candidate" };
      } } });
    expect(recorded[0]).toEqual([]); expect(recorded[1]?.length).toBeGreaterThan(0); expect(result.final.state).toBe("needs_human");
  });
});
describe("page boundaries and report provenance", () => {
  it("exposes a failed empty baseline as inconclusive rather than a zero-finding success", async () => {
    const result = await runPage({ source: "<img>", proposer: createMockProposer([]), createEngine: () => ({ id: "jsdom", audit: async () => ({ ...audit(), status: "timeout", errors: [{ code: "audit_timeout", message: "timeout" }] }) }) });
    expect(result).toMatchObject({ status: "inconclusive", reasons: ["baseline_timeout", "audit_timeout"] });
  });
  it("rejects >200000 UTF8 bytes before engine construction", async () => {
    let created = false;
    const result = await runPage({ source: "😀".repeat(50001), proposer: createMockProposer([]), createEngine() { created = true; return { id: "jsdom", audit: async () => audit() }; } });
    expect(result).toMatchObject({ status: "input_rejected", inputBytes: 200004 }); expect(created).toBe(false);
  });
  it("uses first50 ordinal/rule queue while retaining every audited finding and noneligible rule", async () => {
    const source = `<body>${"<img>".repeat(52)}</body>`;
    const imageFindings = Array.from({ length: 52 }, (_, i) => finding("image-alt", i + 1));
    const other = finding("landmark-one-main", 0);
    const baseline = audit([...imageFindings].reverse().concat(other));
    const seen: number[] = [];
    const result = await runPage({ source, createEngine: () => ({ id: "jsdom", audit: async () => baseline }),
      proposer: { id: "queue", mode: "mock", async propose(f) { if (f.ordinal !== null) seen.push(f.ordinal); return { kind: "abstain", reason: "test" }; } } });
    if (result.status !== "audited") throw new Error("fixture");
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(result.artifact.baseline.findings).toHaveLength(53);
    expect(result.artifact.queue).toMatchObject({ eligibleCount: 52, attemptedCount: 50, truncatedCount: 2, flag: "proposal_queue_truncated" });
    expect(result.artifact.items.find((item) => item.finding.rule === "landmark-one-main")?.state).toBe("not_attempted");
    const hash = async (value: string) => `hash:${value}`;
    const report = await buildJsonReport(result.artifact, { sha256: hash, engineProfileText: "EXACT-PROFILE-TEXT" });
    expect(report).toMatchObject({ mode: "mock", axeVersion: "scripted-unit", engineProfile: "scripted-unit", sourceSha256: await hash(source), renderSha256: await hash(result.artifact.baselineRender), engineProfileSha256: "hash:EXACT-PROFILE-TEXT", export: { state: "not_requested" } });
  });
  it("hashes the exact combined audit rendering without generating another nonce/render", async () => {
    const source = "<img>"; const target = finding("image-alt", 0); let audits = 0; let renders = 0;
    const hash = async (value: string) => `hash:${value}`;
    const proposer = createMockProposer([{ fingerprint: "image-alt:0", attempts: [{ kind: "ops", ops: [{ op: "set_attr", fingerprint: "image-alt:0", name: "alt", value: "Mountain lake" }] }] }]);
    const result = await runPage({ source, proposer, createEngine: () => ({ id: "jsdom", audit: async () => ++audits === 1 ? audit([target]) : audit() }),
      render: (text, insertedTitleStart) => `${buildRenderCopy(text, { insertedTitleStart }).html}<!--nonce:${++renders}-->` });
    if (result.status !== "audited") throw new Error("fixture");
    const final = result.artifact.fixes[0]?.final;
    if (final?.resolved === undefined || final.gate === undefined) throw new Error("no accepted fixture fix");
    const key = { pageSha256: await hash(source), rule: "image-alt", ordinal: 0, opsSha256: await hash(JSON.stringify(final.resolved.ops)), engineProfile: "scripted-unit" };
    const combined = await combineFixes({ page: result.artifact.page, baseline: result.artifact.baseline, engine: result.artifact.engine,
      fixes: [{ id: "one", key, resolved: final.resolved, gate: final.gate }], rulings: [{ key, action: "approve", seq: 1 }], sha256: hash, render: result.artifact.render });
    if (combined.state !== "ready") throw new Error("combined fixture failed");
    const renderCount = renders;
    const report = await buildJsonReport(result.artifact, { sha256: hash, engineProfileText: "profile", combined });
    expect(report.export).toMatchObject({ state: "ready", renderSha256: await hash(combined.rendered) });
    expect(renders).toBe(renderCount); expect(combined.rendered).toContain("<!--nonce:3-->");
  });
});
