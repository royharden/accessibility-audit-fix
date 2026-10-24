import type { AuditResult, Finding } from "../audit/types.ts";

export type GateId = "strict" | "target-only" | "score-delta" | "region-scoped";
export type GateState = "verified" | "checked" | "rejected" | "inconclusive" | "needs_human" | "not_applicable";
export type NameCheck = "passed" | "failed" | "skipped_not_measured" | "not_applicable";
export interface GateResult {
  readonly gate: GateId;
  readonly state: GateState;
  readonly accepted: boolean | null;
  readonly reasons: readonly string[];
  readonly nameCheck: NameCheck;
}
export type GateTarget = Pick<Finding, "rule" | "ordinal" | "fingerprint" | "unmappedReason">;
export function gateResult(gate: GateId, state: GateState, reasons: readonly string[] = [], nameCheck: NameCheck = "not_applicable"): GateResult {
  return { gate, state, accepted: state === "verified" || state === "checked" ? true : state === "rejected" ? false : null, reasons, nameCheck };
}
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
}
export function comparisonReasons(baseline: AuditResult, after: AuditResult): string[] {
  const reasons: string[] = [];
  if (baseline.status !== "complete") reasons.push(`baseline_${baseline.status}`);
  if (after.status !== "complete") reasons.push(`after_${after.status}`);
  if (baseline.errors.length > 0 || after.errors.length > 0) reasons.push("audit_errors");
  if (baseline.engine !== after.engine) reasons.push("engine_mismatch");
  if (baseline.profile !== after.profile) reasons.push("profile_mismatch");
  if (baseline.axeVersion !== after.axeVersion) reasons.push("axe_version_mismatch");
  if (!sameSet(baseline.notMeasured, after.notMeasured)) reasons.push("measurement_coverage_mismatch");
  return reasons;
}
export function targetReasons(after: AuditResult, target: GateTarget): string[] {
  const reasons: string[] = [];
  if (after.findings.some((f) => f.fingerprint === target.fingerprint)) reasons.push("target_still_violating");
  if (after.incomplete.some((f) => f.fingerprint === target.fingerprint)) reasons.push("target_still_incomplete");
  return reasons;
}
export function targetEvidenceReasons(baseline: AuditResult, target: GateTarget): string[] {
  if (target.ordinal === null || target.fingerprint === null) return [];
  if (target.fingerprint !== `${target.rule}:${target.ordinal}`) return ["target_identity_mismatch"];
  return [...baseline.findings, ...baseline.incomplete].some((f) => f.fingerprint === target.fingerprint) ? [] : ["target_not_in_baseline"];
}
function unmappedCounts(findings: readonly Finding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) if (f.ordinal === null) {
    const key = `${f.rule}:${f.unmappedReason ?? "unmapped"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
/** Full audited rules, including non-MVP rules. Preexisting findings may remain; downgrades never pass. */
export function regressionReasons(baseline: AuditResult, after: AuditResult): string[] {
  const before = new Set([...baseline.findings, ...baseline.incomplete].flatMap((f) => f.fingerprint === null ? [] : [f.fingerprint]));
  const violations = new Set(baseline.findings.flatMap((f) => f.fingerprint === null ? [] : [f.fingerprint]));
  const reasons: string[] = [];
  for (const [kind, list] of [["violation", after.findings], ["incomplete", after.incomplete]] as const) {
    for (const f of list) if (f.fingerprint !== null && !before.has(f.fingerprint)) reasons.push(`new_${kind}:${f.fingerprint}`);
    const countsBefore = unmappedCounts(kind === "violation" ? baseline.findings : baseline.incomplete);
    for (const [key, count] of unmappedCounts(list)) if (count > (countsBefore.get(key) ?? 0)) reasons.push(`unmapped_count_increased:${kind}:${key}`);
  }
  for (const f of after.incomplete) if (f.fingerprint !== null && violations.has(f.fingerprint)) reasons.push(`violation_downgraded:${f.fingerprint}`);
  return [...new Set(reasons)];
}
