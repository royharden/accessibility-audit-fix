// Metrics operate on result-row structure, never hidden oracle files. One row is one planted defect/proposer.
import type { GateId, GateResult } from "../gate/reasons.ts";
import { wilson, unknownRate } from "../stats/wilson.ts";

export interface MetricRow {
  readonly table: "traps" | "heldout" | "act"; readonly pageId: string; readonly rule: string; readonly bucket: "mechanical" | "content";
  readonly proposer: string; readonly measurement: "measured" | "not_measured";
  readonly baselineDetected: boolean | null; readonly baselineStable: boolean | null; readonly eligible: boolean;
  readonly beforeProposalHuman: boolean; readonly inconclusive: boolean;
  readonly firstPass: { readonly state: string; readonly stage: string | null; readonly oracleCorrect: boolean | null;
    readonly gates: Readonly<Record<GateId, GateResult>> | null };
  readonly afterRetry: { readonly state: string; readonly oracleCorrect: boolean | null };
  readonly costUsdMicros: number | null;
  readonly humanApproved: boolean | null;
}
export const GATES: readonly GateId[] = ["target-only", "score-delta", "region-scoped", "strict"];
export function summarizeRows(rows: readonly MetricRow[]) {
  const measured = rows.filter((r) => r.measurement === "measured");
  // Failed/unstable baselines cannot establish either a detection or a miss. Keep them visible outside
  // coverage's denominator, including a stable baseline whose detection observation is still unknown.
  const knownBaseline = (r: MetricRow): boolean => r.baselineStable === true && r.baselineDetected !== null;
  const baselineObservations = measured.filter(knownBaseline);
  const unknownBaselines = measured.filter((r) => !knownBaseline(r));
  const eligible = measured.filter((r) => r.eligible);
  const conclusive = eligible.filter((r) => !r.inconclusive);
  const yieldFor = (bucket: MetricRow["bucket"], state: "verified" | "checked", first: boolean) => {
    const phase = (r: MetricRow) => first ? r.firstPass : r.afterRetry;
    const units = eligible.filter((r) => r.bucket === bucket && phase(r).state !== "inconclusive");
    const unknown = units.some((r) => phase(r).state === state && phase(r).oracleCorrect === null);
    return unknown ? unknownRate(units.length) : wilson(units.filter((r) => phase(r).state === state && phase(r).oracleCorrect === true).length, units.length);
  };
  const gates = Object.fromEntries(GATES.map((gate) => {
    let acceptedCorrect = 0; let acceptedWrong = 0; let rejectedCorrect = 0; let rejectedWrong = 0;
    let oracleUnknown = 0; let inconclusive = 0; let notApplicable = 0;
    // First-pass only. All gates see the same first proposal; pre-gate rejections never enter these cells.
    for (const row of eligible) {
      const outcome = row.firstPass.gates?.[gate]; if (outcome === undefined) continue;
      if (outcome.state === "not_applicable") { notApplicable++; continue; }
      if (outcome.accepted === null) { inconclusive++; continue; }
      if (row.firstPass.oracleCorrect === null) { oracleUnknown++; continue; }
      if (outcome.accepted && row.firstPass.oracleCorrect) acceptedCorrect++;
      else if (outcome.accepted) acceptedWrong++;
      else if (row.firstPass.oracleCorrect) rejectedCorrect++; else rejectedWrong++;
    }
    return [gate, { acceptedCorrect, acceptedWrong, rejectedCorrect, rejectedWrong, oracleUnknown, inconclusive, notApplicable,
      falseAcceptRate: oracleUnknown > 0 ? unknownRate(acceptedCorrect + acceptedWrong) : wilson(acceptedWrong, acceptedCorrect + acceptedWrong),
      correctFixAcceptance: oracleUnknown > 0 ? unknownRate(acceptedCorrect + rejectedCorrect) : wilson(acceptedCorrect, acceptedCorrect + rejectedCorrect) }] as const;
  }));
  const costKnown = measured.length > 0 && measured.every((r) => r.costUsdMicros !== null);
  const cost = costKnown ? measured.reduce((sum, r) => sum + (r.costUsdMicros ?? 0), 0) : null;
  const countState = (state: string) => measured.filter((r) => r.afterRetry.state === state).length;
  const costPer = (n: number) => cost === null || n === 0 ? null : cost / n;
  return { planted: rows.length, notMeasured: rows.length - measured.length,
    detectionCoverage: wilson(baselineObservations.filter((r) => r.baselineDetected === true).length, baselineObservations.length),
    unknownBaselines: unknownBaselines.length, baselineInconclusive: unknownBaselines.filter((r) => r.inconclusive).length,
    eligible: eligible.length, attempted: eligible.filter((r) => !r.beforeProposalHuman).length,
    inconclusive: measured.filter((r) => r.inconclusive).length, eligibleInconclusive: eligible.filter((r) => r.inconclusive).length,
    unstableBaselines: measured.filter((r) => r.baselineStable === false).length,
    conclusiveEligible: conclusive.length,
    preGateRejections: eligible.filter((r) => ["schema", "matrix", "value"].includes(r.firstPass.stage ?? "")).length,
    firstPassMechanicalYield: yieldFor("mechanical", "verified", true), firstPassContentYield: yieldFor("content", "checked", true),
    afterRetryStrictMechanicalYield: yieldFor("mechanical", "verified", false), afterRetryStrictContentYield: yieldFor("content", "checked", false),
    gates, costUsdMicros: cost, costPerVerifiedUsdMicros: costPer(countState("verified")), costPerCheckedUsdMicros: costPer(countState("checked")),
    humanApprovals: measured.some((r) => r.humanApproved !== null) ? measured.filter((r) => r.humanApproved === true).length : null };
}
export function groupedMetrics(rows: readonly MetricRow[]) {
  const keys = new Set(rows.flatMap((r) => [`${r.table}\t${r.proposer}\t${r.bucket}\t${r.rule}`, `${r.table}\t${r.proposer}\t${r.bucket}\tALL`]));
  return [...keys].sort().map((key) => {
    const [table = "", proposer = "", bucket = "", rule = ""] = key.split("\t");
    return { table, proposer, bucket, rule, metrics: summarizeRows(rows.filter((r) => r.table === table && r.proposer === proposer && r.bucket === bucket && (rule === "ALL" || r.rule === rule))) };
  });
}
