// what_bug_this_catches: target disappearance hiding full-page regressions/downgrades, failed audits interpreted
// as empty pages, profile mixing, lost source anchors, and jsdom name checks silently counted as verified.
// Hand-built AuditResults only. Written in Dirty Mode, never run.
import { describe, expect, it } from "vitest";
import type { AuditResult, Finding } from "../../src/core/audit/types.ts";
import { formatFingerprint } from "../../src/core/findings/fingerprint.ts";
import type { GateInput } from "../../src/core/gate/strict.ts";
import { strictGate } from "../../src/core/gate/strict.ts";
import { regionScopedGate, scoreDeltaGate, targetOnlyGate } from "../../src/core/gate/variants.ts";
import { parsePage } from "../../src/core/html/parse.ts";

function finding(rule = "tabindex", ordinal: number | null = 1): Finding {
  return { rule, ordinal, fingerprint: ordinal === null ? null : formatFingerprint(rule, ordinal), impact: "serious",
    cite: ordinal === null ? null : { file: "page.html", line: 1, col: 1 }, unmappedReason: ordinal === null ? "unmapped" : null, summary: null, contrast: null };
}
function audit(findings: readonly Finding[] = [], incomplete: readonly Finding[] = [], changes: Partial<AuditResult> = {}): AuditResult {
  return { status: "complete", findings, incomplete, engine: "jsdom", axeVersion: "test", profile: "test-profile",
    notMeasured: ["color-contrast", "label-content-name-mismatch"], errors: [], ...changes };
}
function input(changes: Partial<GateInput> = {}): GateInput {
  const target = finding();
  return { baseline: audit([target]), after: audit(), target, invariants: { ok: true, reasons: [] }, changedNames: [], ...changes };
}

describe("strict measurement and states", () => {
  it("distinguishes mechanical verified and content checked", () => {
    expect(strictGate(input())).toMatchObject({ state: "verified", accepted: true });
    const target = finding("image-alt");
    expect(strictGate(input({ target, baseline: audit([target]), changedNames: [1] })))
      .toMatchObject({ state: "checked", nameCheck: "skipped_not_measured" });
  });
  it.each(["error", "timeout", "partial"] as const)("makes %s audits inconclusive on either side", (status) => {
    expect(strictGate(input({ after: audit([], [], { status }) })).state).toBe("inconclusive");
    expect(strictGate(input({ baseline: audit([finding()], [], { status }) })).state).toBe("inconclusive");
  });
  it.each([
    { engine: "iframe" as const }, { profile: "different" }, { axeVersion: "different" }, { notMeasured: [] },
    { errors: [{ code: "partial", message: "failed check" }] },
  ])("rejects cross-measurement comparison as inconclusive: %j", (changes) => {
    expect(strictGate(input({ after: audit([], [], changes) })).state).toBe("inconclusive");
  });
  it("does not invent target measurement or source identity", () => {
    expect(strictGate(input({ baseline: audit() })).reasons).toContain("target_not_in_baseline");
    expect(strictGate(input({ target: { ...finding(), fingerprint: "tabindex:99" } })).reasons).toContain("target_identity_mismatch");
    const unmapped = finding("tabindex", null);
    expect(strictGate(input({ target: unmapped, baseline: audit([unmapped]) }))).toMatchObject({ state: "needs_human", reasons: ["unmapped"] });
    const target = finding("color-contrast");
    expect(strictGate(input({ target, baseline: audit([target]) })).reasons).toContain("target_not_measured");
  });
});

describe("strict target and full-page regression checks", () => {
  it("requires target absent from both violations and incomplete", () => {
    expect(strictGate(input({ after: audit([finding()]) })).reasons).toContain("target_still_violating");
    expect(strictGate(input({ after: audit([], [finding()]) })).reasons).toContain("target_still_incomplete");
  });
  it("allows unchanged preexisting findings but rejects any rule's new violation/incomplete", () => {
    const preexisting = finding("landmark-one-main", 5);
    expect(strictGate(input({ baseline: audit([finding(), preexisting]), after: audit([preexisting]) })).state).toBe("verified");
    expect(strictGate(input({ after: audit([preexisting]) })).reasons).toContain("new_violation:landmark-one-main:5");
    expect(strictGate(input({ after: audit([], [preexisting]) })).reasons).toContain("new_incomplete:landmark-one-main:5");
  });
  it("rejects violation-to-incomplete downgrades even for preexisting non-target rules", () => {
    const preexisting = finding("landmark-one-main", 5);
    expect(strictGate(input({ baseline: audit([finding(), preexisting]), after: audit([], [preexisting]) })).reasons)
      .toContain("violation_downgraded:landmark-one-main:5");
  });
  it("compares unanchored multiplicities by rule/reason/status rather than ignoring null fingerprints", () => {
    const node = { ...finding("landmark-one-main", null), unmappedReason: "implied_element" as const };
    expect(strictGate(input({ baseline: audit([finding(), node]), after: audit([node]) })).state).toBe("verified");
    expect(strictGate(input({ baseline: audit([finding(), node]), after: audit([node, node]) })).reasons)
      .toContain("unmapped_count_increased:violation:landmark-one-main:implied_element");
    expect(strictGate(input({ baseline: audit([finding(), node]), after: audit([], [node]) })).state).toBe("rejected");
  });
  it("rejects invariant failure and changed names that fail/are incomplete under a measuring engine", () => {
    expect(strictGate(input({ invariants: { ok: false, reasons: ["visible_text_changed"] } })).reasons).toContain("invariant:visible_text_changed");
    const target = finding("button-name");
    const baseline = audit([target], [], { notMeasured: [] });
    expect(strictGate(input({ target, baseline, after: audit([], [], { notMeasured: [] }), changedNames: [1] })).nameCheck).toBe("passed");
    expect(strictGate(input({ target, baseline, after: audit([finding("label-content-name-mismatch")], [], { notMeasured: [] }), changedNames: [1] })).reasons)
      .toContain("changed_name_mismatch");
    expect(strictGate(input({ target, baseline, after: audit([], [finding("label-content-name-mismatch")], { notMeasured: [] }), changedNames: [1] })).nameCheck).toBe("failed");
  });
});

describe("eval-only weaker gates", () => {
  it("exposes weak acceptance when the target disappears but a different defect is introduced", () => {
    const i = input({ after: audit([finding("landmark-one-main", 9)]) });
    expect(strictGate(i).state).toBe("rejected");
    expect(targetOnlyGate(i).accepted).toBe(true);
    expect(scoreDeltaGate(i).accepted).toBe(true);
    expect(scoreDeltaGate(input({ after: audit([finding(), finding("label", 9)]) })).accepted).toBe(false);
  });
  it("reports page-level regions n/a and limits ordinary regions to the parent subtree", () => {
    const page = parsePage('<html><head></head><body><section><button></button></section><aside><img></aside></body></html>');
    const button = page.elements.find((e) => e.tagName === "button");
    const aside = page.elements.find((e) => e.tagName === "aside");
    if (button === undefined || aside === undefined) throw new Error("fixture");
    const target = finding("button-name", button.ordinal);
    const outside = finding("landmark-one-main", aside.ordinal);
    const i = input({ target, baseline: audit([target]), after: audit([outside]) });
    expect(regionScopedGate(i, page).accepted).toBe(true);
    expect(strictGate(i).state).toBe("rejected");
    const inside = finding("landmark-one-main", button.ordinal);
    expect(regionScopedGate({ ...i, after: audit([inside]) }, page).accepted).toBe(false);
    expect(regionScopedGate(input({ target: finding("document-title", 0) }), page).state).toBe("not_applicable");
  });
});
