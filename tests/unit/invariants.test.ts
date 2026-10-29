// what_bug_this_catches: delete-to-pass, renamed/reordered element identities, disappearing interactive controls,
// duplicate-id regressions, byte-changed script/handler payloads, forged offsets, and ineffective op effects.
// Dirty Mode: written, never run.
import { describe, expect, it } from "vitest";
import type { PatchDescription } from "../../src/core/html/invariants.ts";
import { checkInvariants, handlerPrints, idMultiplicity, interactiveInventory, scriptPrints, visibleBodyText } from "../../src/core/html/invariants.ts";
import type { Edit } from "../../src/core/html/patch.ts";
import { computeDeltas, spliceEdits } from "../../src/core/html/patch.ts";
import { parsePage } from "../../src/core/html/parse.ts";
import { resolveOps } from "../../src/core/ops/resolve.ts";
import { applyResolved } from "../../src/core/ops/apply.ts";

function mutate(source: string, tag: string, oldText: string, replacement: string) {
  const page = parsePage(source);
  const record = page.elements.find((e) => e.tagName === tag);
  if (record === undefined) throw new Error(`missing ${tag}`);
  const start = source.indexOf(oldText, record.startTag.start);
  if (start < 0) throw new Error("missing mutation text");
  const edits: Edit[] = [{ start, end: start + oldText.length, text: replacement, ordinal: record.ordinal, within: record.startTag, purpose: "attr_replace" }];
  const patch: PatchDescription = { edits, retag: null, insertsTitle: false, titleText: null, attrEffects: [] };
  return checkInvariants(page, patch, { text: spliceEdits(source, edits), deltas: computeDeltas(edits), insertedTitleStart: null });
}

describe("shared measurement functions", () => {
  it("measures body text while excluding head metadata and inert text containers", () => {
    const page = parsePage('<html><head><title>Ignore</title></head><body> A\n <span>B &amp; C</span><script>x()</script><style>x{}</style><template>D</template><noscript>E</noscript></body></html>');
    expect(visibleBodyText(page)).toBe("A B & C");
  });

  it("uses native interactive, nonnegative tabindex, and handler membership with role/focusability", () => {
    const page = parsePage('<button>Go</button><div tabindex="2" role="button">A</div><span onclick="go()">B</span>' +
      '<div tabindex="-1">C</div><p>D</p><template><button>E</button></template>');
    expect(interactiveInventory(page).map((e) => [e.key, e.native, e.focusable, e.inTabOrder, e.role, e.handlers])).toEqual([
      ["o0", "focusable", true, true, null, []],
      ["o1", "not_focusable", true, true, "button", []],
      ["o2", "not_focusable", false, false, null, ["onclick"]],
    ]);
  });

  // what_bug_this_catches: a long zero prefix turned a negative tabindex into -0 and incorrectly enrolled a
  // non-native element in the inventory. Positive, signed-zero and large values retain their classification.
  it.each([
    ["0000000000000003", true],
    ["+0000000000000003", true],
    ["-0000000000000001", false],
    ["0000000000000000", true],
    ["+0000000000000000", true],
    ["-0000000000000000", true],
    ["123456789012345678901234567890", true],
    ["-123456789012345678901234567890", false],
    ["000000000000000123456789012345678901234567890", true],
    ["-000000000000000123456789012345678901234567890", false],
  ] as const)("classifies tabindex inventory membership after zero stripping: %s", (value, member) => {
    const page = parsePage(`<div tabindex="${value}" role="button">Go</div>`);
    expect(interactiveInventory(page)).toEqual(member ? [{
      key: "o0", native: "not_focusable", focusable: true, inTabOrder: true, role: "button", handlers: [],
    }] : []);
  });

  it("keeps preexisting duplicate ids fixable and counts names safely", () => {
    const page = parsePage('<div id="same"></div><span id="same"></span><b id="__proto__"></b><template><i id="same"></i></template>');
    expect([...idMultiplicity(page)]).toEqual([["same", 2], ["__proto__", 1]]);
    const outcome = resolveOps(page, { rule: "button-name", fingerprint: "button-name:0" }, [
      { op: "set_attr", fingerprint: "button-name:0", name: "aria-label", value: "Panel" },
    ]);
    if (!outcome.ok) throw new Error(outcome.reasons.join(","));
    const applied = applyResolved(page, outcome.resolved);
    if (!applied.ok) throw new Error(applied.reason);
    expect(checkInvariants(page, outcome.resolved, applied).ok).toBe(true);
  });

  it("retains exact script and duplicate handler bytes rather than only decoded values", () => {
    const a = parsePage('<svg><script>&amp;</script></svg><button ONCLICK="a&amp;b" onclick="second()">Go</button>');
    const b = parsePage('<svg><script>&#38;</script></svg><button ONCLICK="a&#38;b" onclick="second()">Go</button>');
    expect(scriptPrints(a)).not.toEqual(scriptPrints(b));
    expect(handlerPrints(a)[0]?.decoded).toEqual(handlerPrints(b)[0]?.decoded);
    expect(handlerPrints(a)[0]?.raw).toHaveLength(2);
    expect(handlerPrints(a)[0]?.raw).not.toEqual(handlerPrints(b)[0]?.raw);
  });
});

describe("invariant rejection reasons", () => {
  it("detects changed ids and newly introduced duplicate ids", () => {
    const result = mutate('<div id="one"></div><span id="two"></span>', "span", 'id="two"', 'id="one"');
    expect(result.reasons).toContain("id_multiplicity_changed");
    expect(result.reasons).toContain("new_duplicate_id");
  });

  it("detects body text changes and removal/reordering of elements", () => {
    expect(mutate('<p>Original</p>', "p", "Original", "Changed").reasons).toContain("visible_text_changed");
    const removed = mutate('<div><button>Go</button></div>', "div", '<button>Go</button>', "");
    expect(removed.reasons).toContain("element_count_changed");
    expect(removed.reasons).toContain("interactive_inventory_changed");
    const reordered = mutate('<div><i>A</i><b>B</b></div>', "div", '<i>A</i><b>B</b>', '<b>B</b><i>A</i>');
    expect(reordered.reasons).toContain("element_sequence_changed");
  });

  it("detects role/focusability loss, changed scripts, and byte-changed handlers", () => {
    expect(mutate('<div tabindex="0" role="button">Go</div>', "div", 'tabindex="0"', 'tabindex="-1"').reasons)
      .toContain("interactive_inventory_changed");
    expect(mutate('<div tabindex="0" role="button">Go</div>', "div", 'role="button"', 'role="link"').reasons)
      .toContain("interactive_inventory_changed");
    expect(mutate('<script>safe()</script>', "script", "safe()", "evil()").reasons).toContain("script_changed");
    expect(mutate('<button onclick="a&amp;b">Go</button>', "button", "a&amp;b", "a&#38;b").reasons).toContain("handler_attr_changed");
  });

  it("checks resolved-range provenance, actual text, claimed deltas, and observed effects independently", () => {
    const page = parsePage('<img>');
    const result = resolveOps(page, { rule: "image-alt", fingerprint: "image-alt:0" }, [
      { op: "set_attr", fingerprint: "image-alt:0", name: "alt", value: "Mountains" },
    ]);
    if (!result.ok) throw new Error(result.reasons.join(","));
    const applied = applyResolved(page, result.resolved);
    if (!applied.ok) throw new Error(applied.reason);
    expect(checkInvariants(page, result.resolved, { ...applied, text: `${applied.text}tampered` }).reasons).toContain("patch_mismatch");
    expect(checkInvariants(page, result.resolved, { ...applied, deltas: [] }).reasons).toContain("patch_mismatch");
    expect(checkInvariants(page, { ...result.resolved, edits: result.resolved.edits.map((e) => ({ ...e, within: { start: 0, end: 0 } })) }, applied).reasons)
      .toContain("edit_outside_resolved_range");
    expect(checkInvariants(page, { ...result.resolved, attrEffects: [{ ordinal: 0, name: "alt", value: "Different" }] }, applied).reasons)
      .toContain("op_effect_not_observed");
    expect(checkInvariants(page, result.resolved, { ...applied, insertedTitleStart: 0 }).reasons).toContain("inserted_title_not_found");
  });

  it("detects BOM removal and incorrect title promises", () => {
    const page = parsePage('\ufeff<html><head></head><body></body></html>');
    const patch: PatchDescription = { edits: [], retag: null, insertsTitle: false, titleText: "Missing", attrEffects: [] };
    const result = checkInvariants(page, patch, { text: page.view, deltas: [], insertedTitleStart: null });
    expect(result.reasons).toContain("bom_changed");
    expect(result.reasons).toContain("title_text_not_observed");
  });
});
