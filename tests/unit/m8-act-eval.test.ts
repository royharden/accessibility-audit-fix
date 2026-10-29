// what_bug_this_catches: ACT passed cases receiving repairs, incomplete-only detections counted as
// reproduced failures, or external expectations silently becoming a semantic repair oracle. Not run.
import { describe, expect, it } from "vitest";
import type { AuditResult, Finding } from "../../src/core/audit/types.ts";
import { actTargets, ActCaseRecordSchema } from "../../src/node/actEval.ts";
import { parseResultsJsonl, parseActCaseRecords, resultsMarkdown } from "../../src/node/resultsSchema.ts";
const target: Finding = { rule: "image-alt", ordinal: 0, fingerprint: "image-alt:0", impact: "serious", cite: null, unmappedReason: null, summary: null, contrast: null };
const audit: AuditResult = { status: "complete", findings: [target], incomplete: [], engine: "jsdom", axeVersion: "scripted-unit", profile: "scripted-unit", errors: [], notMeasured: [] };
const caseRow = { schemaVersion: 1, kind: "act_case", id: "unit", actRuleId: "external", axeRule: "image-alt", expectation: "passed", stable: true, baselineStatus: "complete", mappedViolations: 1, eligibleTargets: 0, proposedTargets: 0, sourceSha256: "a".repeat(64), engineProfile: "scripted-unit", reasons: ["act_passed_case_no_proposal"] };
describe("ACT local evaluation eligibility", () => {
  it("never proposes for passed cases, and requires a stable complete mapped violation", () => {
    expect(actTargets("passed", "image-alt", audit, true)).toEqual([]);
    expect(actTargets("failed", "image-alt", audit, true)).toEqual([target]);
    for (const baseline of [{ ...audit, status: "partial" as const }, { ...audit, findings: [], incomplete: [target] }, { ...audit, notMeasured: ["image-alt"] }, { ...audit, findings: [{ ...target, ordinal: null, fingerprint: null, unmappedReason: "unmapped" as const }] }]) expect(actTargets("failed", "image-alt", baseline, true)).toEqual([]);
    expect(actTargets("failed", "image-alt", audit, false)).toEqual([]);
    expect(actTargets("failed", "button-name", audit, true)).toEqual([]);
  });
  it("keeps case coverage separate from scored defect rows, even with no repair rows", () => {
    const saved = JSON.stringify(ActCaseRecordSchema.parse(caseRow)) + "\n";
    expect(parseResultsJsonl(saved)).toEqual([]); expect(parseActCaseRecords(saved)).toHaveLength(1);
    expect(resultsMarkdown([], parseActCaseRecords(saved))).toContain("ACT");
    expect(ActCaseRecordSchema.safeParse({ ...caseRow, proposedTargets: 1 }).success).toBe(false);
    expect("oracleCorrect" in ActCaseRecordSchema.parse(caseRow)).toBe(false);
  });
});
