// what_bug_this_catches: F5 ordinal drift after an allowed op, edits escaping their resolved source slices,
// accidental AST serialization, BOM/astral offset loss, heading identity changes or inserted title renumbering.
// This covers all allowed operation kinds and set_attr names; iframe inert-strip properties belong to M7.
// Dirty Mode: written, never run.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Op } from "../../src/shared/opsSchema.ts";
import type { Edit } from "../../src/core/html/patch.ts";
import { escapeTitleText } from "../../src/core/html/patch.ts";
import { parsePage } from "../../src/core/html/parse.ts";
import { checkInvariants } from "../../src/core/html/invariants.ts";
import { resolveOps } from "../../src/core/ops/resolve.ts";
import { applyResolved } from "../../src/core/ops/apply.ts";

const CASES = [
  "alt", "decorative", "aria-label", "aria-labelledby", "lang", "title", "frame-title", "tabindex-set",
  "tabindex-remove", "color", "both-colors", "retag", "title-fill", "title-insert",
] as const;
type Case = (typeof CASES)[number];

interface Scenario {
  readonly rule: string;
  readonly tag: string;
  readonly target: string;
  readonly ops: (fingerprint: string) => Op[];
}

function scenario(kind: Case, name: string, positiveTabindex: number): Scenario {
  switch (kind) {
    case "alt": return { rule: "image-alt", tag: "img", target: '<img src="same.png">', ops: (fingerprint) => [{ op: "set_attr", fingerprint, name: "alt", value: name }] };
    case "decorative": return { rule: "image-alt", tag: "img", target: '<img alt="old" src="same.png"/>', ops: (fingerprint) => [{ op: "mark_decorative", fingerprint }] };
    case "aria-label": return { rule: "button-name", tag: "button", target: '<button class="keep">Go</button>', ops: (fingerprint) => [{ op: "set_attr", fingerprint, name: "aria-label", value: name }] };
    case "aria-labelledby": return { rule: "label", tag: "input", target: '<input type="text">', ops: (fingerprint) => [{ op: "set_attr", fingerprint, name: "aria-labelledby", value: "label-name" }] };
    case "lang": return { rule: "html-has-lang", tag: "html", target: "", ops: (fingerprint) => [{ op: "set_attr", fingerprint, name: "lang", value: "en-GB" }] };
    case "title": return { rule: "link-name", tag: "a", target: '<a href="#" title=old>Go</a>', ops: (fingerprint) => [{ op: "set_attr", fingerprint, name: "title", value: name }] };
    case "frame-title": return { rule: "frame-title", tag: "iframe", target: '<iframe></iframe>', ops: (fingerprint) => [{ op: "set_attr", fingerprint, name: "title", value: name }] };
    case "tabindex-set": return { rule: "tabindex", tag: "div", target: `<div tabindex='${positiveTabindex}' role="button">Go</div>`, ops: (fingerprint) => [{ op: "set_attr", fingerprint, name: "tabindex", value: "0" }] };
    case "tabindex-remove": return { rule: "tabindex", tag: "button", target: `<button tabindex=${positiveTabindex}>Go</button>`, ops: (fingerprint) => [{ op: "remove_attr", fingerprint, name: "tabindex" }] };
    case "color": return { rule: "color-contrast", tag: "p", target: '<p style="padding:  2px; color: red">Text</p>', ops: (fingerprint) => [{ op: "set_style_color", fingerprint, property: "color", value: "#000000" }] };
    case "both-colors": return { rule: "color-contrast", tag: "p", target: '<p class="keep">Text</p>', ops: (fingerprint) => [
      { op: "set_style_color", fingerprint, property: "color", value: "rgb(0, 0, 0)" },
      { op: "set_style_color", fingerprint, property: "background-color", value: "white" },
    ] };
    case "retag": return { rule: "heading-order", tag: "h4", target: '<H4 class="keep">Heading</H4>', ops: (fingerprint) => [{ op: "retag_heading", fingerprint, level: 2 }] };
    case "title-fill":
    case "title-insert": return { rule: "document-title", tag: "html", target: "", ops: (fingerprint) => [{ op: "set_document_title", fingerprint, text: name }] };
  }
}

/** Independent source-segment check: every unedited slice and replacement has its promised exact bytes. */
function expectOnlyResolvedRanges(source: string, output: string, edits: readonly Edit[]): void {
  let cursor = 0;
  let shift = 0;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    expect(output.slice(cursor + shift, e.start + shift)).toBe(source.slice(cursor, e.start));
    expect(output.slice(e.start + shift, e.start + shift + e.text.length)).toBe(e.text);
    expect(e.start).toBeGreaterThanOrEqual(e.within.start);
    expect(e.end).toBeLessThanOrEqual(e.within.end);
    cursor = e.end;
    shift += e.text.length - (e.end - e.start);
  }
  expect(output.slice(cursor + shift)).toBe(source.slice(cursor));
}

/** Independent known-delta offset calculation, with left affinity for tag ends at title insert boundaries. */
function shifted(offset: number, edits: readonly Edit[], end = false): number {
  return offset + edits.filter((e) => e.end <= offset && !(end && e.start === offset && e.end === offset))
    .reduce((sum, e) => sum + e.text.length - (e.end - e.start), 0);
}

describe("allowed HTML ops preserve source identity (F5)", () => {
  const name = fc.array(fc.constantFrom("a", "Z", "é", "😀", "&", '"', " "), { minLength: 1, maxLength: 24 })
    .map((characters) => `Scenery ${characters.join("")} view`);

  it.each(CASES)("preserves original ordinals and bytes for %s", (kind) => {
    fc.assert(fc.property(name, fc.boolean(), fc.integer({ min: 1, max: 30000 }), (value, bom, tab) => {
      const s = scenario(kind, value, tab);
      const title = kind === "title-insert" ? "" : kind === "title-fill" ? "<title></title>" : "<title>Existing</title>";
      // Put the target first in body so its tag is selected unambiguously. Identical sibling images and inert
      // template descendants must still retain their distinct source identity after every edit.
      const source = `${bom ? "\ufeff" : ""}<html><head>${title}</head><body>${s.target}` +
        `<span id="label-name">${escapeTitleText(value)}</span><img src="same.png"><img src="same.png">` +
        '<span id="dup">A</span><span id="dup">B</span><span onclick="keep()">Stable</span>' +
        '<script>const stable = "&amp;";</script><template><img src="same.png"></template></body></html>';
      const before = parsePage(source);
      const target = before.elements.find((e) => e.tagName === s.tag);
      if (target === undefined) throw new Error(`missing ${s.tag}`);
      const fingerprint = `${s.rule}:${target.ordinal}`;
      const outcome = resolveOps(before, { rule: s.rule, fingerprint }, s.ops(fingerprint));
      if (!outcome.ok) throw new Error(outcome.reasons.join(","));
      const applied = applyResolved(before, outcome.resolved);
      if (!applied.ok) throw new Error(applied.reason);
      expectOnlyResolvedRanges(source, applied.text, outcome.resolved.edits);
      expect(applied.text.startsWith("\ufeff")).toBe(bom);
      expect(applied.text).not.toContain("data-a11y-");
      const after = parsePage(applied.text, { insertedTitleStart: applied.insertedTitleStart });
      const inserted = kind === "title-insert";
      expect(after.elements.length).toBe(before.elements.length + (inserted ? 1 : 0));
      expect(after.insertedTitleOrdinal).toBe(inserted ? before.elements.length : null);
      before.elements.forEach((b) => {
        const a = after.elements[b.ordinal];
        expect(a).toBeDefined();
        if (a === undefined) return;
        expect([a.ordinal, a.tagName, a.namespace, a.parentOrdinal, a.inTemplate]).toEqual([
          b.ordinal, kind === "retag" && b.ordinal === target.ordinal ? "h2" : b.tagName,
          b.namespace, b.parentOrdinal, b.inTemplate,
        ]);
        expect(a.startTag).toEqual({ start: shifted(b.startTag.start, outcome.resolved.edits), end: shifted(b.startTag.end, outcome.resolved.edits, true) });
        expect(a.endTag).toEqual(b.endTag === null ? null : {
          start: shifted(b.endTag.start, outcome.resolved.edits), end: shifted(b.endTag.end, outcome.resolved.edits, true),
        });
      });
      expect(checkInvariants(before, outcome.resolved, applied).reasons).toEqual([]);
    }), { numRuns: 100 });
  });
});
