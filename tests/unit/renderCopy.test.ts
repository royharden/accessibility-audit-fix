// what_bug_this_catches: attacker-supplied ordinal markers surviving into the audited tree, template content
// getting different ordinals, or trusted audit-only markers leaking into source patches. Written, not run.
import { describe, expect, it } from "vitest";
import { getAttr, parsePage, walkTree } from "../../src/core/html/parse.ts";
import { buildRenderCopy, ORDINAL_MARKER_ATTR, parseOrdinalMarker, UNANCHORED_MARKER_ATTR } from "../../src/core/html/renderCopy.ts";
import { applyResolved } from "../../src/core/ops/apply.ts";
import { resolveOps } from "../../src/core/ops/resolve.ts";

describe("trusted render copy markers", () => {
  it("strips both input marker kinds and injects the shared walk's ordinals, including templates", () => {
    const source = '<p DATA-A11Y-ORD="999" data-a11y-unanchored="implied_element">a</p>' +
      '<template><img data-a11y-ord="999"></template><p>b</p>';
    const copy = buildRenderCopy(source);
    const rendered = parsePage(copy.html);
    const anchored = copy.page.entries.filter((_, i) => copy.page.entryOrdinals[i] !== null);
    expect(copy.strippedInputMarkers).toBe(3);
    expect(copy.ordinalCount).toBe(copy.page.elements.length);
    const marked = rendered.entries.filter((e) => getAttr(e, ORDINAL_MARKER_ATTR) !== null);
    expect(marked.map((e) => [e.tagName, getAttr(e, ORDINAL_MARKER_ATTR), e.inTemplate]))
      .toEqual(anchored.map((e) => [e.tagName, String(copy.page.entryOrdinals[e.index]), e.inTemplate]));
    expect(marked.some((e) => getAttr(e, ORDINAL_MARKER_ATTR) === "999")).toBe(false);
    for (const e of rendered.entries) {
      const attrs = e.node.attrs.filter((a) => a.name === ORDINAL_MARKER_ATTR || a.name === UNANCHORED_MARKER_ATTR);
      expect(attrs).toHaveLength(1);
    }
    expect(copy.page.original).toBe(source);
  });

  it("marks implied and recovery elements without inventing ordinals", () => {
    const copy = buildRenderCopy("<p><b>x<p>y</b>");
    const rendered = parsePage(copy.html);
    const reasons = rendered.entries.map((e) => getAttr(e, UNANCHORED_MARKER_ATTR)).filter((x) => x !== null);
    expect(reasons).toContain("implied_element");
    expect(reasons).toContain("no_source_anchor");
    expect(rendered.entries.filter((e) => e.tagName === "b").every((e) => getAttr(e, ORDINAL_MARKER_ATTR) === null)).toBe(true);
  });

  it("strips markers introduced by an engine transform before restoring trusted markers", () => {
    const copy = buildRenderCopy("<p>x</p>", {
      transform(tree) {
        for (const e of walkTree(tree)) e.node.attrs.push({ name: ORDINAL_MARKER_ATTR, value: "999" });
      },
    });
    expect(copy.html).not.toContain('data-a11y-ord="999"');
    const p = parsePage(copy.html).entries.find((e) => e.tagName === "p");
    expect(p === undefined ? null : getAttr(p, ORDINAL_MARKER_ATTR)).toBe("0");
  });

  it("keeps the inserted title at ordinal n in the render copy", () => {
    const original = "<html><head></head><body><p>x</p></body></html>";
    const patched = original.replace("</head>", "<title>New</title></head>");
    const copy = buildRenderCopy(patched, { insertedTitleStart: patched.indexOf("<title>") });
    const rendered = parsePage(copy.html);
    const title = rendered.entries.find((e) => e.tagName === "title");
    expect(title === undefined ? null : getAttr(title, ORDINAL_MARKER_ATTR)).toBe(String(parsePage(original).elements.length));
  });

  it("never exports the render tree or its trusted markers through source patching", () => {
    const source = '<img src="a.png">';
    const copy = buildRenderCopy(source);
    expect(copy.html).toContain(ORDINAL_MARKER_ATTR);
    const page = parsePage(source);
    const outcome = resolveOps(page, { rule: "image-alt", fingerprint: "image-alt:0" }, [
      { op: "set_attr", fingerprint: "image-alt:0", name: "alt", value: "Mountains" },
    ]);
    if (!outcome.ok) throw new Error(outcome.reasons.join(","));
    const applied = applyResolved(page, outcome.resolved);
    expect(applied).toMatchObject({ ok: true, text: '<img src="a.png" alt="Mountains">' });
    if (applied.ok) expect(applied.text).not.toContain("data-a11y-");
  });

  it.each([null, "", "01", "-1", "1.0", "1e2", " 1", "1000000000"])("rejects noncanonical marker %s", (value) => {
    expect(parseOrdinalMarker(value)).toBeNull();
  });

  it("accepts canonical marker values only", () => {
    expect(parseOrdinalMarker("0")).toBe(0);
    expect(parseOrdinalMarker("999999999")).toBe(999999999);
  });
});
