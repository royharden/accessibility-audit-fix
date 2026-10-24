import { z } from "../shared/deps.ts";
import { ELIGIBLE_RULE_IDS, bucketOf } from "../shared/rules.ts";
import { groupedMetrics } from "../core/metrics/gateTable.ts";
import type { Rate } from "../core/stats/wilson.ts";
import { ActCaseRecordSchema } from "./actEval.ts";
import type { ActCaseRecord } from "./actEval.ts";
const Hash = z.string().regex(/^[a-f0-9]{64}$/).nullable();
const State = z.enum(["verified", "checked", "rejected", "inconclusive", "needs_human", "not_attempted", "not_measured", "not_applicable"]);
const Cache = z.object({ key: z.string(), originCallId: z.string(), originAttemptId: z.string() }).strict();
const Review = z.object({ decision: z.enum(["pass", "reject", "route", "inconclusive"]), reasons: z.array(z.string()), cache: Cache.optional() }).strict();
export const GateResultSchema = z.object({ gate: z.enum(["strict", "target-only", "score-delta", "region-scoped"]),
  state: z.enum(["verified", "checked", "rejected", "inconclusive", "needs_human", "not_applicable"]), accepted: z.boolean().nullable(),
  reasons: z.array(z.string()), nameCheck: z.enum(["passed", "failed", "skipped_not_measured", "not_applicable"]) }).strict().superRefine((gate, ctx) => {
    const accepted = gate.state === "verified" || gate.state === "checked" ? true : gate.state === "rejected" ? false : null;
    if (accepted !== gate.accepted) ctx.addIssue({ code: "custom", message: "gate_acceptance_mismatch" });
  });
const Gates = z.object({ strict: GateResultSchema, "target-only": GateResultSchema, "score-delta": GateResultSchema, "region-scoped": GateResultSchema }).strict();
const FirstPass = z.object({ state: State, stage: z.string().nullable(), reasons: z.array(z.string()), oracleCorrect: z.boolean().nullable(), gates: Gates.nullable(), cache: Cache.optional(), review: Review.optional() }).strict();
const Final = z.object({ state: State, reasons: z.array(z.string()), oracleCorrect: z.boolean().nullable(), strict: GateResultSchema.nullable(), attempts: z.number().int().nonnegative().max(3), cache: Cache.optional(), review: Review.optional() }).strict();
export const ResultRowSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("defect"), table: z.enum(["traps", "heldout", "act"]), pageId: z.string().min(1), family: z.string(),
  rule: z.enum(ELIGIBLE_RULE_IDS), ordinal: z.number().int().nonnegative().nullable(), fingerprint: z.string().nullable(), bucket: z.enum(["mechanical", "content"]),
  proposer: z.string().min(1), mode: z.enum(["mock", "live"]), measurement: z.enum(["measured", "not_measured"]),
  sourceSha256: Hash, renderSha256: Hash, engineProfileSha256: Hash, engineProfile: z.string().nullable(), axeVersion: z.string().nullable(), engine: z.enum(["jsdom", "iframe"]).nullable(),
  baselineDetected: z.boolean().nullable(), baselineStable: z.boolean().nullable(), eligible: z.boolean(), beforeProposalHuman: z.boolean(), inconclusive: z.boolean(),
  firstPass: FirstPass, afterRetry: Final, costUsdMicros: z.number().int().nonnegative().nullable(), humanApproved: z.boolean().nullable(),
}).strict().superRefine((row, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (row.bucket !== bucketOf(row.rule)) issue("bucket_mismatch");
  if (row.eligible !== (row.measurement === "measured" && row.baselineStable === true && row.baselineDetected === true)) issue("eligibility_mismatch");
  if (row.measurement === "not_measured" && (row.baselineDetected !== null || row.eligible)) issue("unmeasured_has_detection");
  if (row.firstPass.gates !== null && row.firstPass.stage !== "gate") issue("gate_results_before_gate");
  if (row.firstPass.stage === "gate" && row.firstPass.gates === null) issue("missing_first_gate_results");
  if (row.fingerprint !== null && row.fingerprint !== `${row.rule}:${row.ordinal}`) issue("fingerprint_mismatch");
  if ((row.ordinal === null) !== (row.fingerprint === null)) issue("fingerprint_anchor_mismatch");
  for (const [name, gate] of Object.entries(row.firstPass.gates ?? {})) if (gate.gate !== name) issue("gate_column_mismatch");
  if (row.afterRetry.strict !== null && row.afterRetry.strict.gate !== "strict") issue("final_gate_not_strict");
  if (row.proposer === "mock" && row.table !== "traps") issue("mock_outside_trap_table");
});
export const NotRunSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("not_run"), reason: z.string().min(1) }).strict();
export const ResultsRecordSchema = z.union([ResultRowSchema, NotRunSchema, ActCaseRecordSchema]);
export type ResultRow = z.infer<typeof ResultRowSchema>;
export function parseResultsJsonl(text: string): ResultRow[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").flatMap((line) => {
    const record = ResultsRecordSchema.parse(JSON.parse(line) as unknown); return record.kind === "defect" ? [record] : [];
  });
}
export function parseActCaseRecords(text: string): ActCaseRecord[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").flatMap((line) => { const record = ResultsRecordSchema.parse(JSON.parse(line) as unknown); return record.kind === "act_case" ? [record] : []; });
}
const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
/** Sole failure-list input is validated saved result rows; no fixture/HTML/oracle reads or manual numbers. */
export function failuresMarkdown(rows: readonly ResultRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.measurement !== "measured") continue;
    const add = (phase: string, gate: string, kind: string, reasons: readonly string[]) => lines.push(`| ${[row.table, row.pageId, row.fingerprint ?? `${row.rule}:unmapped`, row.rule, row.proposer, phase, gate, kind, reasons.join(", ")].map(cell).join(" | ")} |`);
    for (const [gate, result] of Object.entries(row.firstPass.gates ?? {})) {
      if (result.accepted === true && row.firstPass.oracleCorrect === false) add("first", gate, result.state === "verified" ? "false_verified" : "false_checked", result.reasons);
      if (result.accepted === false && row.firstPass.oracleCorrect === true) add("first", gate, "rejected_but_correct", result.reasons);
    }
    if (row.firstPass.state === "needs_human" || (row.eligible && row.firstPass.state === "not_attempted")) add("first", "none", "abstained", row.firstPass.reasons);
    if ((row.afterRetry.state === "verified" || row.afterRetry.state === "checked") && row.afterRetry.oracleCorrect === false) add("final", "strict", row.afterRetry.state === "verified" ? "false_verified" : "false_checked", row.afterRetry.reasons);
    if (row.afterRetry.state === "rejected" && row.afterRetry.oracleCorrect === true && row.afterRetry.strict !== null) add("final", "strict", "rejected_but_correct", row.afterRetry.reasons);
    if (row.afterRetry.state === "needs_human") add("final", "none", "abstained", row.afterRetry.reasons);
  }
  return rows.length === 0 ? "# Evaluation failures\n\nNot run. No measured result rows exist.\n" :
    `# Evaluation failures\n\nGenerated only from validated results.jsonl rows; scripted traps are separate unit evidence.\n\n| Table | Page | Fingerprint | Rule | Proposer | Phase | Gate | Classification | Reasons |\n|---|---|---|---|---|---|---|---|---|\n${lines.join("\n")}\n`;
}
function rateText(rate: Rate): string {
  if (rate.value === null) return rate.denominator === 0 ? "n/a (n=0)" : "n/a (oracle unavailable)";
  return `${rate.numerator}/${rate.denominator} = ${(rate.value * 100).toFixed(1)}% [${((rate.low ?? 0) * 100).toFixed(1)}, ${((rate.high ?? 1) * 100).toFixed(1)}]${rate.smallN ? " *n<10*" : ""}`;
}
/** All numbers come from result rows. The three evidence tables are deliberately never pooled. */
export function resultsMarkdown(rows: readonly ResultRow[], actCases: readonly ActCaseRecord[] = []): string {
  const output = ["# Evaluation results", "", rows.length === 0 && actCases.length === 0 ? "Not run. No measured rows exist." : "Generated from validated results.jsonl only.", "",
    "95% Wilson intervals; n<10 flagged. Defects on one page are dependent: intervals do not adjust for page clustering. Human approvals are unmeasured and never replace oracle correctness. First-pass gate columns replay one identical proposal; schema/matrix/value rejections stay outside gate cells. First-pass code-gate comparison is recorded before optional Noul filtering; review/cache provenance stays separate. After-retry yields use the effective strict result after filtering.", "",
    "Detection coverage divides detected targets by known detection/miss observations from stable measured baselines. Failed, unstable or unknown baseline observations are excluded, never counted as misses. Inconclusive totals include all measured rows; baseline and eligible counts show the subgroups. Baseline unknown and unstable counts can overlap: unstable means baselineStable=false, including failed or partial audits where stability was not established.", ""];
  for (const table of ["traps", "heldout", "act"] as const) {
    output.push(`## ${table === "traps" ? "Scripted traps (unit evidence; no generalisation)" : table === "heldout" ? "Held-out planted defects" : "ACT external cases (separate; not headline)"}`, "");
    const selected = rows.filter((row) => row.table === table);
    if (table === "act" && actCases.length > 0) output.push(`Actual cases: ${actCases.length}; passed cases with zero proposals: ${actCases.filter((item) => item.expectation === "passed" && item.proposedTargets === 0).length}; stable failed cases with mapped violations: ${actCases.filter((item) => item.expectation === "failed" && item.stable && (item.mappedViolations ?? 0) > 0).length}; baseline-inconclusive cases: ${actCases.filter((item) => !item.stable).length}; passed-case mapping disagreements: ${actCases.filter((item) => item.expectation === "passed" && item.stable && (item.mappedViolations ?? 0) > 0).length}. Repair oracle remains unknown/unscored.`, "");
    if (selected.length === 0) { output.push(table === "act" && actCases.length > 0 ? "No eligible reproduced repair targets; no correctness rate is claimed." : "Not run / not measured.", ""); continue; }
    output.push("| Proposer | Rule | Bucket | Planted | Detection coverage (known stable baselines) | Eligible / attempted | Inconclusive (all / baseline / eligible) | Baseline unknown / unstable | Pre-gate rejects | First-pass correct yield | After-retry strict correct yield | Human approvals | Cost / verified / checked (micros) |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const group of groupedMetrics(selected)) {
      const m = group.metrics; const mechanical = group.bucket === "mechanical";
      output.push(`| ${[group.proposer, group.rule, group.bucket, String(m.planted), rateText(m.detectionCoverage), `${m.eligible} / ${m.attempted}`, `${m.inconclusive} / ${m.baselineInconclusive} / ${m.eligibleInconclusive}`, `${m.unknownBaselines} / ${m.unstableBaselines}`, String(m.preGateRejections), rateText(mechanical ? m.firstPassMechanicalYield : m.firstPassContentYield), rateText(mechanical ? m.afterRetryStrictMechanicalYield : m.afterRetryStrictContentYield), m.humanApprovals === null ? "n/a" : String(m.humanApprovals), [m.costUsdMicros, m.costPerVerifiedUsdMicros, m.costPerCheckedUsdMicros].map((cost) => cost === null ? "n/a" : String(cost)).join(" / ")].map(cell).join(" | ")} |`);
    }
    output.push("", "| Proposer | Rule | Bucket | Gate (first pass) | Accepted correct / wrong | Rejected correct / wrong | False-accept rate | Correct-fix acceptance | Unknown oracle / inconclusive / n/a |", "|---|---|---|---|---|---|---|---|---|");
    for (const group of groupedMetrics(selected)) for (const [gate, m] of Object.entries(group.metrics.gates)) output.push(`| ${[group.proposer, group.rule, group.bucket, gate, `${m.acceptedCorrect} / ${m.acceptedWrong}`, `${m.rejectedCorrect} / ${m.rejectedWrong}`, rateText(m.falseAcceptRate), rateText(m.correctFixAcceptance), `${m.oracleUnknown} / ${m.inconclusive} / ${m.notApplicable}`].map(cell).join(" | ")} |`);
    const notMeasured = selected.filter((row) => row.measurement === "not_measured");
    if (notMeasured.length > 0) output.push("", `Not measured: ${[...new Set(notMeasured.map((row) => row.proposer))].join(", ")}. These rows contribute no eligible/gate/yield denominator.`);
    output.push("");
  }
  output.push("## Held-out detection quota (actual stable baseline detections)", "", "Planted quota is not detection coverage. This table deduplicates proposer rows by page/rule/ordinal.", "");
  const units = new Map<string, ResultRow>();
  for (const row of rows) if (row.table === "heldout" && row.measurement === "measured") units.set(`${row.pageId}:${row.rule}:${row.ordinal}`, row);
  if (units.size === 0) output.push("Not measured.");
  else {
    output.push("| Rule | Planted | Detected | Required | Detection shortfall |", "|---|---|---|---|---|");
    for (const rule of ELIGIBLE_RULE_IDS.filter((id) => id !== "color-contrast")) {
      const cases = [...units.values()].filter((row) => row.rule === rule);
      const detected = cases.filter((row) => row.baselineStable === true && row.baselineDetected === true).length;
      output.push(`| ${rule} | ${cases.length} | ${detected} | 10 | ${Math.max(0, 10 - detected)} |`);
    }
  }
  return `${output.join("\n")}\n`;
}
