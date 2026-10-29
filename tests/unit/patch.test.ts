// what_bug_this_catches: token splices breaking unquoted/self-closing tags, duplicate attributes exposing a
// second value, style edits rewriting unrelated declarations, or ambiguous patch ranges silently applying.
// Dirty Mode: written, never run.
import { describe, expect, it } from "vitest";
import type { Edit } from "../../src/core/html/patch.ts";
import {
  computeDeltas, escapeAttrValue, escapeTitleText, findEditConflicts, mapOffset, removeAttrEdit,
  rewriteStyleValue, scanStartTag, setAttrEdit, spliceEdits,
} from "../../src/core/html/patch.ts";
import { applyEdits } from "../../src/core/ops/apply.ts";

function scan(source: string) {
  const result = scanStartTag(source, { start: 0, end: source.length });
  if (result === null) throw new Error("test tag did not scan");
  return result;
}

function set(source: string, name: string, value: string): string {
  const edit = setAttrEdit(scan(source), name, value, { ordinal: 0 });
  if (typeof edit === "string") throw new Error(edit);
  return spliceEdits(source, [edit]);
}

describe("attribute splices", () => {
  it.each([
    ["<img>", '<img alt="A &amp; &quot;B&quot;">'],
    ["<img/>", '<img alt="A &amp; &quot;B&quot;"/>'],
    ["<img />", '<img alt="A &amp; &quot;B&quot;" />'],
    ["<img src=a/>", '<img src=a/ alt="A &amp; &quot;B&quot;">'],
    ["<img alt=old>", '<img alt="A &amp; &quot;B&quot;">'],
    ["<img alt='old'>", '<img alt="A &amp; &quot;B&quot;">'],
    ["<img alt>", '<img alt="A &amp; &quot;B&quot;">'],
    ['<img alt = "old" >', '<img alt = "A &amp; &quot;B&quot;" >'],
  ])("inserts/replaces within %s", (source, expected) => {
    expect(set(source, "alt", 'A & "B"')).toBe(expected);
  });

  it("escapes values once, without interpreting existing entity text", () => {
    expect(escapeAttrValue('&amp; "')).toBe("&amp;amp; &quot;");
    expect(escapeTitleText("</title>&")).toBe("&lt;/title&gt;&amp;");
  });

  it("refuses duplicates, including mixed-case names", () => {
    const source = '<img ALT="first" alt="second">';
    expect(setAttrEdit(scan(source), "alt", "new", { ordinal: 0 })).toBe("duplicate_attribute");
    const tab = '<button tabindex="2" TABINDEX="4">';
    expect(removeAttrEdit(tab, scan(tab), "tabindex", { ordinal: 0 })).toBe("duplicate_attribute");
  });

  it("removes only tabindex and its preceding whitespace", () => {
    const source = '<button  tabindex=3\n class="a">';
    const edit = removeAttrEdit(source, scan(source), "tabindex", { ordinal: 0 });
    if (typeof edit === "string") throw new Error(edit);
    expect(spliceEdits(source, [edit])).toBe('<button\n class="a">');
  });

  it("refuses a dangling equals sign rather than inserting into its value", () => {
    expect(scanStartTag("<img src=>", { start: 0, end: 10 })).toBeNull();
  });
});

describe("style splices", () => {
  it("preserves every other declaration and existing important flag", () => {
    expect(rewriteStyleValue("font-family: 'A;B'; COLOR : red !important; padding:  2px", [
      { property: "color", value: "#000" }, { property: "background-color", value: "white" },
    ])).toEqual({ ok: true, value: "font-family: 'A;B'; COLOR : #000 !important; padding:  2px; background-color: white" });
  });

  it.each(["color:red;color:blue", "COLOR:red; color:blue"])("abstains on duplicate existing declarations: %s", (raw) => {
    expect(rewriteStyleValue(raw, [{ property: "color", value: "black" }])).toEqual({ ok: false, reason: "duplicate_style_declaration" });
  });

  it("abstains on repeated requested properties even with no existing declaration", () => {
    expect(rewriteStyleValue("", [{ property: "color", value: "red" }, { property: "color", value: "blue" }]))
      .toEqual({ ok: false, reason: "duplicate_style_declaration" });
  });

  it.each(["/*x*/ color:red", "color:r\\ed", "color:&#114;ed", "color:rgb(1,2,3", "broken", "{color:red}"])("abstains on non-simple style: %s", (raw) => {
    expect(rewriteStyleValue(raw, [{ property: "color", value: "black" }])).toEqual({ ok: false, reason: "style_unparseable" });
  });

  it.each(["red; display:none", "url(x)", "red!important", 'red"', "/*x*/red"])("rejects unsafe replacement: %s", (value) => {
    expect(rewriteStyleValue("", [{ property: "color", value }])).toEqual({ ok: false, reason: "value_not_safe_for_style" });
  });
});

describe("patch geometry", () => {
  const edit = (start: number, end: number, text = "X"): Edit => ({
    start, end, text, ordinal: 0, within: { start: 0, end: 20 }, purpose: "attr_replace",
  });

  it("rejects overlap and insertion/replacement ambiguity, permits an insertion at the end", () => {
    expect(findEditConflicts([edit(2, 5), edit(4, 6)])).toEqual([[0, 1]]);
    expect(findEditConflicts([edit(2, 2), edit(2, 2)])).toEqual([[0, 1]]);
    expect(findEditConflicts([edit(2, 5), edit(2, 2)])).toEqual([[0, 1]]);
    expect(findEditConflicts([edit(2, 5), edit(5, 5)])).toEqual([]);
    expect(applyEdits("abcdefghij", [edit(2, 5), edit(4, 6)])).toMatchObject({ ok: false, reason: "overlapping_ranges" });
  });

  it("applies descending offsets and maps UTF-16 deltas with boundary affinity", () => {
    const edits = [edit(1, 1, "😀"), edit(4, 5, "long")];
    expect(spliceEdits("abcdef", edits)).toBe("a😀bcdlongf");
    const deltas = computeDeltas(edits);
    expect(mapOffset(deltas, 1)).toBe(3);
    expect(mapOffset(deltas, 1, "left")).toBe(1);
    expect(mapOffset(deltas, 6)).toBe(11);
    expect(mapOffset(computeDeltas([edit(2, 5)]), 3)).toBeNull();
  });

  it("refuses invalid bounds, empty edits, and edits touching the BOM", () => {
    expect(applyEdits("abc", [edit(-1, 0)])).toMatchObject({ ok: false, reason: "edit_out_of_bounds" });
    expect(applyEdits("abc", [edit(1.5, 2)])).toMatchObject({ ok: false, reason: "edit_out_of_bounds" });
    expect(applyEdits("abc", [])).toMatchObject({ ok: false, reason: "no_edits" });
    expect(applyEdits("\ufeffabc", [edit(0, 1)])).toMatchObject({ ok: false, reason: "edit_touches_bom" });
  });
});
