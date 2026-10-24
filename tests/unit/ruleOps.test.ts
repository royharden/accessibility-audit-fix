// what_bug_this_catches: the rule -> allowed-op matrix drifting from PLAN.md 2.3 / CL 2.5 (an op becoming legal
// for the wrong rule, e.g. aria-label on an image or set_style_color on a name rule), a second matrix appearing,
// or ops aimed at a different finding than the one being fixed. Written in Dirty Mode, not run.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Op } from "../../src/core/ops/index.ts";
import { RULE_OPS, checkOpsForFinding, checkOpsForRule, isOpAllowedForRule, opSignature } from "../../src/core/ops/index.ts";
import { ELIGIBLE_RULE_IDS } from "../../src/core/rules.ts";

const EXPECTED: Record<string, { allowed: string[]; maxOps: number }> = {
  "html-has-lang": { allowed: ["set_attr:lang"], maxOps: 1 },
  "document-title": { allowed: ["set_document_title"], maxOps: 1 },
  "image-alt": { allowed: ["set_attr:alt", "mark_decorative"], maxOps: 1 },
  "button-name": { allowed: ["set_attr:aria-label", "set_attr:aria-labelledby", "set_attr:title"], maxOps: 1 },
  "link-name": { allowed: ["set_attr:aria-label", "set_attr:aria-labelledby", "set_attr:title"], maxOps: 1 },
  label: { allowed: ["set_attr:aria-label", "set_attr:aria-labelledby", "set_attr:title"], maxOps: 1 },
  "frame-title": { allowed: ["set_attr:title"], maxOps: 1 },
  "heading-order": { allowed: ["retag_heading"], maxOps: 1 },
  tabindex: { allowed: ["remove_attr:tabindex", "set_attr:tabindex"], maxOps: 1 },
  "color-contrast": { allowed: ["set_style_color:color", "set_style_color:background-color"], maxOps: 2 },
};

function sample(fingerprint: string): Op[] {
  return [
    { op: "set_attr", fingerprint, name: "alt", value: "x" },
    { op: "set_attr", fingerprint, name: "aria-label", value: "x" },
    { op: "set_attr", fingerprint, name: "aria-labelledby", value: "x" },
    { op: "set_attr", fingerprint, name: "lang", value: "en" },
    { op: "set_attr", fingerprint, name: "title", value: "x" },
    { op: "set_attr", fingerprint, name: "tabindex", value: "0" },
    { op: "remove_attr", fingerprint, name: "tabindex" },
    { op: "set_style_color", fingerprint, property: "color", value: "#000" },
    { op: "set_style_color", fingerprint, property: "background-color", value: "#fff" },
    { op: "retag_heading", fingerprint, level: 2 },
    { op: "set_document_title", fingerprint, text: "x" },
    { op: "mark_decorative", fingerprint },
  ];
}

describe("rule -> op matrix", () => {
  it("has exactly one row per eligible rule and equals the plan's matrix", () => {
    expect(Object.keys(RULE_OPS).sort()).toEqual([...ELIGIBLE_RULE_IDS].sort());
    for (const [rule, expected] of Object.entries(EXPECTED)) {
      const row = RULE_OPS[rule as keyof typeof RULE_OPS];
      expect([...row.allowed].sort(), rule).toEqual([...expected.allowed].sort());
      expect(row.maxOps, rule).toBe(expected.maxOps);
    }
  });

  it("allows exactly the listed op signatures for each rule", () => {
    for (const rule of ELIGIBLE_RULE_IDS) {
      for (const op of sample(`${rule}:1`)) {
        expect(isOpAllowedForRule(rule, op), `${rule} ${opSignature(op)}`).toBe(EXPECTED[rule]?.allowed.includes(opSignature(op)));
      }
    }
  });

  it("returns op_not_allowed_for_rule for a disallowed op", () => {
    const r = checkOpsForRule("image-alt", [{ op: "set_attr", fingerprint: "image-alt:1", name: "aria-label", value: "Shoe" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("op_not_allowed_for_rule");
  });

  it("rejects rules outside the eligible list", () => {
    const r = checkOpsForRule("region", [{ op: "set_attr", fingerprint: "region:1", name: "title", value: "Main" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toEqual(["rule_not_eligible"]);
  });

  it("allows two ops only for color-contrast", () => {
    const fp = "color-contrast:7";
    const two: Op[] = [
      { op: "set_style_color", fingerprint: fp, property: "color", value: "#000" },
      { op: "set_style_color", fingerprint: fp, property: "background-color", value: "#fff" },
    ];
    expect(checkOpsForRule("color-contrast", two).ok).toBe(true);
    const r = checkOpsForRule("button-name", [
      { op: "set_attr", fingerprint: "button-name:2", name: "aria-label", value: "Search" },
      { op: "set_attr", fingerprint: "button-name:2", name: "title", value: "Search" },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toContain("too_many_ops_for_rule");
  });

  it("binds ops to the finding: wrong ordinal or wrong rule in the fingerprint is rejected", () => {
    const finding = { rule: "link-name", fingerprint: "link-name:5" };
    expect(checkOpsForFinding(finding, [{ op: "set_attr", fingerprint: "link-name:5", name: "aria-label", value: "Cart" }]).ok).toBe(true);
    const wrongOrdinal = checkOpsForFinding(finding, [{ op: "set_attr", fingerprint: "link-name:6", name: "aria-label", value: "Cart" }]);
    expect(wrongOrdinal.ok).toBe(false);
    if (!wrongOrdinal.ok) expect(wrongOrdinal.reasons).toContain("op_fingerprint_mismatch");
    const wrongRule = checkOpsForFinding({ rule: "link-name", fingerprint: "button-name:5" }, [
      { op: "set_attr", fingerprint: "button-name:5", name: "aria-label", value: "Cart" },
    ]);
    expect(wrongRule.ok).toBe(false);
  });

  it("property: any op for any eligible rule is accepted iff its signature is in the expected row", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ELIGIBLE_RULE_IDS), fc.integer({ min: 0, max: 11 }), (rule, k) => {
        const op = sample(`${rule}:3`)[k];
        if (op === undefined) return true;
        const expectedAllowed = EXPECTED[rule]?.allowed.includes(opSignature(op)) ?? false;
        return checkOpsForRule(rule, [op]).ok === expectedAllowed;
      }),
    );
  });
});
