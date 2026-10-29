import type { AuditResult } from "../audit/types.ts";
import type { InvariantResult } from "../html/invariants.ts";
import type { ResolvedOps } from "../ops/resolve.ts";
import { bucketOf, isEligibleRule, LABEL_NAME_MISMATCH_RULE_ID } from "../rules.ts";
import type { GateResult, GateTarget, NameCheck } from "./reasons.ts";
import { comparisonReasons, gateResult, regressionReasons, targetEvidenceReasons, targetReasons } from "./reasons.ts";

export interface GateInput {
  readonly baseline: AuditResult;
  readonly after: AuditResult;
  readonly target: GateTarget;
  readonly invariants: Pick<InvariantResult, "ok" | "reasons">;
  /** Required: derive from the resolved edits with changedNameOrdinals, never from model claims. */
  readonly changedNames: readonly number[];
}
const NAME_ATTRIBUTES = new Set(["alt", "aria-label", "aria-labelledby", "title"]);
export function changedNameOrdinals(patches: readonly Pick<ResolvedOps, "attrEffects">[]): number[] {
  return [...new Set(patches.flatMap((p) => p.attrEffects.filter((e) => e.value !== null && NAME_ATTRIBUTES.has(e.name)).map((e) => e.ordinal)))];
}
function nameCheck(input: GateInput): { check: NameCheck; reasons: string[] } {
  if (input.changedNames.length === 0) return { check: "not_applicable", reasons: [] };
  if (input.after.notMeasured.includes(LABEL_NAME_MISMATCH_RULE_ID)) return { check: "skipped_not_measured", reasons: [] };
  const affected = (f: AuditResult["findings"][number]): boolean => f.rule === LABEL_NAME_MISMATCH_RULE_ID &&
    (f.ordinal === null || input.changedNames.includes(f.ordinal));
  const reasons: string[] = [];
  if (input.after.findings.some(affected)) reasons.push("changed_name_mismatch");
  if (input.after.incomplete.some(affected)) reasons.push("changed_name_mismatch_incomplete");
  return { check: reasons.length > 0 ? "failed" : "passed", reasons };
}
export function strictGate(input: GateInput): GateResult {
  const { baseline, after, target } = input;
  const incomparable = comparisonReasons(baseline, after);
  if (incomparable.length > 0) return gateResult("strict", "inconclusive", incomparable);
  if (target.ordinal === null || target.fingerprint === null) return gateResult("strict", "needs_human", [target.unmappedReason ?? "unmapped"]);
  if (!isEligibleRule(target.rule)) return gateResult("strict", "needs_human", ["rule_not_eligible"]);
  const evidence = targetEvidenceReasons(baseline, target);
  if (evidence.length > 0) return gateResult("strict", "inconclusive", evidence);
  if (baseline.notMeasured.includes(target.rule) || after.notMeasured.includes(target.rule)) return gateResult("strict", "inconclusive", ["target_not_measured"]);
  const names = nameCheck(input);
  const reasons = [...targetReasons(after, target), ...regressionReasons(baseline, after),
    ...(input.invariants.ok ? [] : input.invariants.reasons.length > 0 ? input.invariants.reasons.map((r) => `invariant:${r}`) : ["invariant:failed"]), ...names.reasons];
  if (reasons.length > 0) return gateResult("strict", "rejected", [...new Set(reasons)], names.check);
  return gateResult("strict", bucketOf(target.rule) === "mechanical" && names.check !== "skipped_not_measured" ? "verified" : "checked", [], names.check);
}
