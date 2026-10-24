// what_bug_this_catches: n=0 presented as 0%, incorrect Wilson denominators, abstentions disappearing from yield,
// retries contaminating first-pass comparison, schema rejection entering gates, or pooled evidence tables.
// Written in Dirty Mode, never run.
import { describe, expect, it } from "vitest";
import { wilson } from "../../src/core/stats/wilson.ts";
import { summarizeRows, groupedMetrics } from "../../src/core/metrics/gateTable.ts";
import { gateResult } from "../../src/core/gate/reasons.ts";
import type { ResultRow } from "../../src/node/resultsSchema.ts";
import { ResultRowSchema, parseResultsJsonl, failuresMarkdown, resultsMarkdown } from "../../src/node/resultsSchema.ts";

function row(accept: boolean, correct: boolean, changes: Partial<ResultRow> = {}): ResultRow {
  const state = accept ? "verified" : "rejected";
  return ResultRowSchema.parse({ schemaVersion: 1, kind: "defect", table: "heldout", pageId: "page-1", family: "heldout-family", rule: "tabindex", ordinal: 4, fingerprint: "tabindex:4", bucket: "mechanical", proposer: "rules", mode: "mock", measurement: "measured",
    sourceSha256: "a".repeat(64), renderSha256: "b".repeat(64), engineProfileSha256: "c".repeat(64), engineProfile: "unit", axeVersion: "unit", engine: "jsdom",
    baselineDetected: true, baselineStable: true, eligible: true, beforeProposalHuman: false, inconclusive: false,
    firstPass: { state, stage: "gate", reasons: [], oracleCorrect: correct, gates: { strict: gateResult("strict", state), "target-only": gateResult("target-only", accept ? "checked" : "rejected"), "score-delta": gateResult("score-delta", accept ? "checked" : "rejected"), "region-scoped": gateResult("region-scoped", accept ? "checked" : "rejected") } },
    afterRetry: { state, reasons: [], oracleCorrect: correct, strict: gateResult("strict", state), attempts: 1 }, costUsdMicros: null, humanApproved: null, ...changes });
}
// Mirrors eval's persisted shape for unstable/partial/error baselines; raw audit status is not a row field.
function unknownBaseline(reason: string, changes: Partial<ResultRow> = {}): ResultRow {
  return row(false, false, { pageId: `baseline-${reason}`, baselineDetected: null, baselineStable: false, eligible: false, inconclusive: true,
    firstPass: { state: "inconclusive", stage: "audit", reasons: [reason], oracleCorrect: null, gates: null },
    afterRetry: { state: "inconclusive", reasons: [reason], oracleCorrect: null, strict: null, attempts: 0 }, ...changes });
}
describe("Wilson95", () => {
  it("matches known values and leaves zero denominators unavailable", () => {
    expect(wilson(0, 0)).toMatchObject({ value: null, low: null, high: null, denominator: 0 });
    expect(wilson(1, 1).low).toBeCloseTo(0.2065493, 6); expect(wilson(1, 1).high).toBeCloseTo(1);
    expect(wilson(50, 100).low).toBeCloseTo(0.4038315, 6); expect(wilson(50, 100).high).toBeCloseTo(0.5961685, 6);
    expect(wilson(1, 9).smallN).toBe(true); expect(wilson(1, 10).smallN).toBe(false);
    expect(() => wilson(2, 1)).toThrow();
  });
});
describe("fixed evaluation denominators", () => {
  // what_bug_this_catches: one detected stable baseline plus a failed baseline appeared as 50% coverage and
  // zero inconclusive runs. Unknown baseline observations must stay outside coverage and visible in reports.
  it.each([
    ["unstable", "baseline_not_deterministic_or_incomplete"],
    ["partial", "baseline_not_deterministic_or_incomplete"],
    ["error", "baseline_audit_error"],
  ] as const)("excludes an %s baseline from coverage and reports it as inconclusive", (name, reason) => {
    const saved = parseResultsJsonl([row(true, true), unknownBaseline(reason, { pageId: `baseline-${name}` })]
      .map((entry) => JSON.stringify(entry)).join("\n"));
    const m = summarizeRows(saved);
    expect(m.detectionCoverage).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(m).toMatchObject({ unknownBaselines: 1, baselineInconclusive: 1, unstableBaselines: 1,
      eligible: 1, attempted: 1, inconclusive: 1, eligibleInconclusive: 0 });
    const markdown = resultsMarkdown(saved);
    expect(markdown).toContain("Detection coverage (known stable baselines)");
    expect(markdown).toContain("Inconclusive (all / baseline / eligible)");
    expect(markdown).toContain("Baseline unknown / unstable");
    const summary = markdown.split("\n").find((line) => line.startsWith("| rules | tabindex | mechanical |"));
    expect(summary).toContain("| 2 | 1/1 = 100.0%");
    expect(summary).toContain("| 1 / 1 | 1 / 1 / 0 | 1 / 1 |");
  });
  // what_bug_this_catches: filtering failed baselines must retain a known stable miss in the denominator.
  it("counts an observed stable miss while excluding unknown baseline observations", () => {
    const missed = row(false, false, { baselineDetected: false, eligible: false,
      firstPass: { state: "not_attempted", stage: null, reasons: ["baseline_did_not_detect_target"], oracleCorrect: null, gates: null },
      afterRetry: { state: "not_attempted", reasons: ["baseline_did_not_detect_target"], oracleCorrect: null, strict: null, attempts: 0 } });
    expect(summarizeRows([row(true, true), missed, unknownBaseline("baseline_audit_error")]).detectionCoverage)
      .toMatchObject({ numerator: 1, denominator: 2, value: 0.5 });
  });
  // what_bug_this_catches: null detections (even with stable=true), absent stability and failed baselines
  // were treated as observed misses, turning an entirely unknown coverage measurement into a numeric rate.
  it("reports coverage as n/a when no stable known baseline observation exists", () => {
    const rows = [unknownBaseline("baseline_audit_error"),
      unknownBaseline("detection_unknown", { baselineStable: true }), unknownBaseline("stability_unknown", { baselineStable: null })];
    const m = summarizeRows(rows);
    expect(m.detectionCoverage).toMatchObject({ numerator: 0, denominator: 0, value: null, low: null, high: null });
    expect(m).toMatchObject({ unknownBaselines: 3, baselineInconclusive: 3, unstableBaselines: 1,
      inconclusive: 3, eligibleInconclusive: 0, eligible: 0, attempted: 0 });
    const summary = resultsMarkdown(rows).split("\n").find((line) => line.startsWith("| rules | tabindex | mechanical |"));
    expect(summary).toContain("| 3 | n/a (n=0) | 0 / 0 | 3 / 3 / 0 | 3 / 1 |");
  });
  it("reports both false acceptance and correct-fix acceptance", () => {
    const m = summarizeRows([row(true, true), row(true, false), row(false, true), row(false, false)]);
    expect(m.gates["strict"]).toMatchObject({ acceptedCorrect: 1, acceptedWrong: 1, rejectedCorrect: 1, rejectedWrong: 1, falseAcceptRate: { value: 0.5, denominator: 2 }, correctFixAcceptance: { value: 0.5, denominator: 2 } });
    expect(m.afterRetryStrictMechanicalYield).toMatchObject({ numerator: 1, denominator: 4, value: 0.25 });
    const rejecting = summarizeRows([row(false, true), row(false, false)]);
    expect(rejecting.gates["strict"]?.falseAcceptRate.value).toBeNull();
    expect(rejecting.gates["strict"]?.correctFixAcceptance.value).toBe(0);
  });
  it("keeps needs_human in conclusive yield, excludes inconclusive, and counts pre-gate rejection separately", () => {
    const human = row(false, false, { beforeProposalHuman: true, firstPass: { state: "needs_human", stage: "context", reasons: ["screened"], oracleCorrect: null, gates: null }, afterRetry: { state: "needs_human", reasons: ["screened"], oracleCorrect: null, strict: null, attempts: 1 } });
    const timeout = row(false, false, { inconclusive: true, firstPass: { state: "inconclusive", stage: "proposal", reasons: ["provider_timeout"], oracleCorrect: null, gates: null }, afterRetry: { state: "inconclusive", reasons: ["provider_timeout"], oracleCorrect: null, strict: null, attempts: 1 } });
    const schema = row(false, false, { firstPass: { state: "rejected", stage: "schema", reasons: ["schema_invalid"], oracleCorrect: null, gates: null }, afterRetry: { state: "rejected", reasons: ["schema_invalid"], oracleCorrect: null, strict: null, attempts: 3 } });
    const m = summarizeRows([row(true, true), human, timeout, schema]);
    expect(m).toMatchObject({ eligible: 4, attempted: 3, inconclusive: 1, conclusiveEligible: 3, preGateRejections: 1 });
    expect(m.afterRetryStrictMechanicalYield).toMatchObject({ numerator: 1, denominator: 3 });
    expect(m.gates["strict"]?.acceptedCorrect).toBe(1); expect(m.gates["strict"]?.rejectedWrong).toBe(0);
  });
  it("uses first-pass proposals for comparison and final strict only for retry yield", () => {
    const retried = row(false, true, { afterRetry: { state: "verified", reasons: [], oracleCorrect: true, strict: gateResult("strict", "verified"), attempts: 2 } });
    const m = summarizeRows([retried]);
    expect(m.gates["strict"]?.rejectedCorrect).toBe(1); expect(m.firstPassMechanicalYield.value).toBe(0); expect(m.afterRetryStrictMechanicalYield.value).toBe(1);
    expect(m.costUsdMicros).toBeNull(); expect(m.costPerVerifiedUsdMicros).toBeNull();
  });
  it("separates three tables and reports actual detection shortfalls", () => {
    const rows = [row(true, true), row(true, false, { table: "traps", proposer: "mock" })];
    expect(new Set(groupedMetrics(rows).map((group) => group.table))).toEqual(new Set(["heldout", "traps"]));
    const markdown = resultsMarkdown(rows); expect(markdown).toContain("ACT external cases"); expect(markdown).toContain("Detection shortfall");
    expect(ResultRowSchema.safeParse({ ...rows[0], proposer: "mock" }).success).toBe(false);
  });
  it("regenerates failure lists only from validated JSONL and preserves reason/fingerprint identity", () => {
    const rows = [row(true, false), row(false, true)];
    const parsed = parseResultsJsonl(rows.map((entry) => JSON.stringify(entry)).join("\n"));
    const failures = failuresMarkdown(parsed);
    expect(failures).toContain("false_verified"); expect(failures).toContain("rejected_but_correct"); expect(failures).toContain("tabindex:4");
    expect(failuresMarkdown([])).toContain("Not run");
    expect(parseResultsJsonl('{"schemaVersion":1,"kind":"not_run","reason":"Dirty Mode"}\n')).toEqual([]);
  });
});
