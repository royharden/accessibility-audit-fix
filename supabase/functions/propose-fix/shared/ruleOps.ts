// The per-rule allowed-op matrix (PLAN.md 2.3, CL 2.5). This is the ONLY matrix: client-side validation and the
// edge function both use this file (edge copy byte-identical). Violation -> `rejected: op_not_allowed_for_rule`.
// Contextual preconditions are not decidable from ops alone and are enforced by code at resolve time (M2):
//   tabindex: `set_attr tabindex="0"` only replaces a positive value on an element that is NOT natively
//   focusable; `remove_attr tabindex` only when the value is positive and the element IS natively focusable;
//   abstain when focusability is undecidable.
import type { Op, SetAttrName, StyleColorProperty } from "./opsSchema.ts";
import { MAX_OPS_PER_PROPOSAL } from "./opsSchema.ts";
import type { RuleId } from "./rules.ts";
import { isEligibleRule } from "./rules.ts";

export type OpSignature =
  | `set_attr:${SetAttrName}`
  | "remove_attr:tabindex"
  | `set_style_color:${StyleColorProperty}`
  | "retag_heading"
  | "set_document_title"
  | "mark_decorative";

export function opSignature(op: Op): OpSignature {
  switch (op.op) {
    case "set_attr":
      return `set_attr:${op.name}`;
    case "remove_attr":
      return `remove_attr:${op.name}`;
    case "set_style_color":
      return `set_style_color:${op.property}`;
    case "retag_heading":
      return "retag_heading";
    case "set_document_title":
      return "set_document_title";
    case "mark_decorative":
      return "mark_decorative";
  }
}

export interface RuleOpsEntry {
  readonly allowed: readonly OpSignature[];
  /** Maximum ops in one proposal for this rule (never above MAX_OPS_PER_PROPOSAL). */
  readonly maxOps: number;
}

function entry(allowed: readonly OpSignature[], maxOps: number): RuleOpsEntry {
  return Object.freeze({ allowed: Object.freeze([...allowed]), maxOps: Math.min(maxOps, MAX_OPS_PER_PROPOSAL) });
}

const NAME_OPS: readonly OpSignature[] = ["set_attr:aria-label", "set_attr:aria-labelledby", "set_attr:title"];

const MATRIX: Record<RuleId, RuleOpsEntry> = {
  "html-has-lang": entry(["set_attr:lang"], 1),
  "document-title": entry(["set_document_title"], 1),
  "image-alt": entry(["set_attr:alt", "mark_decorative"], 1),
  "button-name": entry(NAME_OPS, 1),
  "link-name": entry(NAME_OPS, 1),
  label: entry(NAME_OPS, 1),
  "frame-title": entry(["set_attr:title"], 1),
  "heading-order": entry(["retag_heading"], 1),
  tabindex: entry(["remove_attr:tabindex", "set_attr:tabindex"], 1),
  "color-contrast": entry(["set_style_color:color", "set_style_color:background-color"], 2),
};

export const RULE_OPS: Readonly<Record<RuleId, RuleOpsEntry>> = Object.freeze(MATRIX);

export type RuleOpsReason =
  | "rule_not_eligible"
  | "no_ops"
  | "op_not_allowed_for_rule"
  | "too_many_ops_for_rule"
  | "op_fingerprint_mismatch";

export type RuleOpsResult = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly RuleOpsReason[] };

export function allowedOpsFor(rule: RuleId): readonly OpSignature[] {
  return RULE_OPS[rule].allowed;
}

export function isOpAllowedForRule(rule: string, op: Op): boolean {
  return isEligibleRule(rule) && RULE_OPS[rule].allowed.includes(opSignature(op));
}

/** Matrix check only: rule eligible, every op allowed for it, op count within the rule's maximum. */
export function checkOpsForRule(rule: string, ops: readonly Op[]): RuleOpsResult {
  if (!isEligibleRule(rule)) return { ok: false, reasons: ["rule_not_eligible"] };
  const reasons: RuleOpsReason[] = [];
  if (ops.length === 0) reasons.push("no_ops");
  if (ops.length > RULE_OPS[rule].maxOps) reasons.push("too_many_ops_for_rule");
  if (ops.some((op) => !RULE_OPS[rule].allowed.includes(opSignature(op)))) reasons.push("op_not_allowed_for_rule");
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Matrix check plus the binding to the finding: every op must carry exactly the finding's fingerprint, and that
 * fingerprint must name the finding's rule (the model never targets another ordinal or rule).
 */
export function checkOpsForFinding(finding: { readonly rule: string; readonly fingerprint: string }, ops: readonly Op[]): RuleOpsResult {
  const base = checkOpsForRule(finding.rule, ops);
  const reasons: RuleOpsReason[] = base.ok ? [] : [...base.reasons];
  const fingerprintNamesRule = finding.fingerprint.startsWith(`${finding.rule}:`);
  if (!fingerprintNamesRule || ops.some((op) => op.fingerprint !== finding.fingerprint)) {
    reasons.push("op_fingerprint_mismatch");
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
