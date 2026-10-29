// Eval-only weaker comparisons. The product/export path uses strictGate exclusively.
import type { Finding } from "../audit/types.ts";
import type { ParsedPage } from "../html/parse.ts";
import { isPageLevelRule } from "../rules.ts";
import type { GateId, GateResult } from "./reasons.ts";
import { comparisonReasons, gateResult, regressionReasons, targetEvidenceReasons, targetReasons } from "./reasons.ts";
import type { GateInput } from "./strict.ts";

function preflight(gate: GateId, input: GateInput): GateResult | null {
  const reasons = comparisonReasons(input.baseline, input.after);
  if (reasons.length > 0) return gateResult(gate, "inconclusive", reasons);
  if (input.target.ordinal === null || input.target.fingerprint === null) return gateResult(gate, "needs_human", [input.target.unmappedReason ?? "unmapped"]);
  const evidence = targetEvidenceReasons(input.baseline, input.target);
  if (evidence.length > 0) return gateResult(gate, "inconclusive", evidence);
  if (input.after.notMeasured.includes(input.target.rule)) return gateResult(gate, "inconclusive", ["target_not_measured"]);
  return null;
}
export function targetOnlyGate(input: GateInput): GateResult {
  const early = preflight("target-only", input);
  if (early !== null) return early;
  const reasons = targetReasons(input.after, input.target);
  return gateResult("target-only", reasons.length > 0 ? "rejected" : "checked", reasons);
}
export function scoreDeltaGate(input: GateInput): GateResult {
  const early = preflight("score-delta", input);
  if (early !== null) return early;
  const reasons = input.after.findings.length > input.baseline.findings.length ? ["violation_count_increased"] : [];
  return gateResult("score-delta", reasons.length > 0 ? "rejected" : "checked", reasons);
}
export function regionScopedGate(input: GateInput, page: ParsedPage): GateResult {
  if (isPageLevelRule(input.target.rule)) return gateResult("region-scoped", "not_applicable", ["page_level_rule"]);
  const early = preflight("region-scoped", input);
  if (early !== null) return early;
  const ordinal = input.target.ordinal;
  const target = ordinal === null ? undefined : page.elements[ordinal];
  if (target === undefined) return gateResult("region-scoped", "inconclusive", ["region_target_missing"]);
  const root = target.parentOrdinal ?? target.ordinal;
  const inRegion = (f: Finding): boolean => {
    // Findings without ordinals cannot be safely assigned to a subtree. Preserve their regression counts
    // conservatively rather than treating lost anchors as a scoped pass.
    if (f.ordinal === null) return true;
    let p: number | null = f.ordinal;
    const visited = new Set<number>();
    while (p !== null && !visited.has(p)) {
      if (p === root) return true;
      visited.add(p);
      p = page.elements[p]?.parentOrdinal ?? null;
    }
    return false;
  };
  const scoped = (audit: GateInput["baseline"]): GateInput["baseline"] => ({ ...audit,
    findings: audit.findings.filter(inRegion), incomplete: audit.incomplete.filter(inRegion) });
  const reasons = [...targetReasons(input.after, input.target), ...regressionReasons(scoped(input.baseline), scoped(input.after))];
  return gateResult("region-scoped", reasons.length > 0 ? "rejected" : "checked", reasons);
}
