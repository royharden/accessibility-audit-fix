// what_bug_this_catches: ordinals drifting from the source (implied html/head/body or parse-recovery clones
// numbered as if they were in the text, template contents skipped, identical siblings collapsed), a BOM shifting
// every splice offset by one, astral characters breaking UTF-16 offsets, wrong file:line:col citations, and
// spoofed data-a11y-ord attributes in the input influencing numbering. Written in Dirty Mode, not run.
import { describe, expect, it } from "vitest";
import type { ParsedPage } from "../../src/core/html/parse.ts";
import { nativeFocusability, parseHtmlInteger, parsePage, walkTree } from "../../src/core/html/parse.ts";

function tags(page: ParsedPage): string[] {
  return page.elements.map((e) => e.tagName);
}

function slice(page: ParsedPage, r: { start: number; end: number }): string {
  return page.original.slice(r.start, r.end);
}

function ordinalOfTag(page: ParsedPage, tag: string, nth = 0): number {
  const found = page.elements.filter((e) => e.tagName === tag)[nth];
  if (found === undefined) throw new Error(`no ${tag} #${nth}`);
  return found.ordinal;
}

describe("ordinal walk", () => {
  it("numbers source-located elements in document pre-order", () => {
    const page = parsePage('<!doctype html><html lang="en"><head><title>T</title></head><body><p>a</p><p>b</p></body></html>');
    expect(tags(page)).toEqual(["html", "head", "title", "body", "p", "p"]);
    expect(page.elements.map((e) => e.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(page.elements.map((e) => e.parentOrdinal)).toEqual([null, 0, 1, 0, 3, 3]);
    expect(page.htmlOrdinal).toBe(0);
    expect(page.htmlReason).toBeNull();
    expect(page.unanchored).toEqual([]);
    for (const e of page.elements) expect(slice(page, e.startTag).toLowerCase().startsWith(`<${e.tagName}`)).toBe(true);
  });

  it("gives identical siblings distinct ordinals", () => {
    const page = parsePage("<ul><li>Same</li><li>Same</li></ul>");
    const lis = page.elements.filter((e) => e.tagName === "li");
    expect(lis.length).toBe(2);
    expect(lis[0]?.ordinal).not.toBe(lis[1]?.ordinal);
    expect(lis[0]?.startTag.start).toBeLessThan(lis[1]?.startTag.start ?? -1);
  });

  it("gives implied html/head/body no ordinal (implied_element)", () => {
    const page = parsePage("<p>x</p>");
    expect(tags(page)).toEqual(["p"]);
    expect(page.htmlOrdinal).toBeNull();
    expect(page.htmlReason).toBe("implied_element");
    expect(page.unanchored.map((u) => [u.tagName, u.reason])).toEqual([
      ["html", "implied_element"],
      ["head", "implied_element"],
      ["body", "implied_element"],
    ]);
    expect(page.elements[0]?.parentOrdinal).toBeNull();
  });

  it("gives an implied tbody no ordinal", () => {
    const page = parsePage("<table><tr><td>x</td></tr></table>");
    expect(tags(page)).toEqual(["table", "tr", "td"]);
    expect(page.unanchored.some((u) => u.tagName === "tbody" && u.reason === "implied_element")).toBe(true);
  });

  it("walks template contents right after the template element", () => {
    const page = parsePage('<body><template><img src="a.png"></template><img src="b.png"></body>');
    expect(tags(page)).toEqual(["body", "template", "img", "img"]);
    const [inside, outside] = page.elements.filter((e) => e.tagName === "img");
    expect(inside?.inTemplate).toBe(true);
    expect(inside?.parentOrdinal).toBe(ordinalOfTag(page, "template"));
    expect(outside?.inTemplate).toBe(false);
  });

  it("never numbers a re-materialised formatting element (no_source_anchor) nor shares one start tag", () => {
    // The second <p> closes the first; "y" reconstructs <b> from the same token. parse5 gives the reconstruction
    // the original token's location, so two elements claim one start tag: neither may get an ordinal.
    const page = parsePage("<p><b>x<p>y</b>");
    expect(page.elements.filter((e) => e.tagName === "p").length).toBe(2);
    const secondP = ordinalOfTag(page, "p", 1);
    const clone = page.unanchored.find((u) => u.tagName === "b" && u.parentOrdinal === secondP);
    expect(clone?.reason).toBe("no_source_anchor");
    const starts = page.elements.map((e) => e.startTag.start);
    expect(new Set(starts).size).toBe(starts.length);
    // Expected parse5 behaviour (location copied): both <b> unnumbered.
    expect(tags(page)).toEqual(["p", "p"]);
  });

  it("gives an adoption-agency clone (no location) no ordinal (no_source_anchor)", () => {
    // </b> runs the adoption agency: the original <b> stays (empty), <p> moves after it, a new <b> wraps "x".
    const page = parsePage("<b><p>x</b>y</p>");
    expect(tags(page)).toEqual(["b", "p"]);
    const clone = page.unanchored.find((u) => u.tagName === "b");
    expect(clone?.reason).toBe("no_source_anchor");
    expect(clone?.parentOrdinal).toBe(ordinalOfTag(page, "p"));
  });

  it("refuses an anchor whose source text is not the element's tag (<image> parsed as img)", () => {
    const page = parsePage('<body><image src="a.png"></body>');
    expect(tags(page)).toEqual(["body"]);
    expect(page.unanchored.find((u) => u.tagName === "img")?.reason).toBe("no_source_anchor");
  });

  it("ignores input data-a11y-ord attributes when numbering", () => {
    const a = parsePage('<p data-a11y-ord="9">x</p><p>y</p>');
    const b = parsePage("<p>x</p><p>y</p>");
    expect(a.elements.map((e) => [e.tagName, e.ordinal])).toEqual(b.elements.map((e) => [e.tagName, e.ordinal]));
  });

  it("records explicit end tags only when they match", () => {
    const page = parsePage("<h2>A</h2><h3>B</h4><p>c");
    const [h2, h3] = page.elements.filter((e) => /^h\d$/.test(e.tagName));
    expect(h2 !== undefined && h2.endTag !== null ? slice(page, h2.endTag) : null).toBe("</h2>");
    expect(h3?.endTag).toBeNull();
    expect(page.elements.find((e) => e.tagName === "p")?.endTag).toBeNull();
  });

  it("walkTree is the same walk parsePage numbers (entries align with ordinals)", () => {
    const page = parsePage("<div><span>a</span><template><i>b</i></template></div>");
    expect(walkTree(page.tree).length).toBe(page.entries.length);
    page.elements.forEach((e) => expect(page.entryOrdinals[e.entry]).toBe(e.ordinal));
  });
});

describe("BOM and UTF-16 offsets", () => {
  const body = '<!doctype html><html lang="fr"><head><title>Café</title></head><body><p>ü 😀 é</p><img src="x.png"></body></html>';

  it("keeps the BOM in original, parses the stripped view and shifts every range by bomDelta", () => {
    const withBom = parsePage(`﻿${body}`);
    const without = parsePage(body);
    expect(withBom.bomDelta).toBe(1);
    expect(without.bomDelta).toBe(0);
    expect(withBom.original.charCodeAt(0)).toBe(0xfeff);
    expect(withBom.view).toBe(body);
    expect(tags(withBom)).toEqual(tags(without));
    withBom.elements.forEach((e, i) => {
      const w = without.elements[i];
      expect(e.startTag.start).toBe((w?.startTag.start ?? -2) + 1);
      expect(slice(withBom, e.startTag)).toBe(w === undefined ? "" : slice(without, w.startTag));
    });
  });

  it("reports offsets in UTF-16 code units across astral characters", () => {
    const text = '<p>😀😀 x</p><img src="y.png">';
    const page = parsePage(text);
    const img = page.elements.find((e) => e.tagName === "img");
    expect(img?.startTag.start).toBe(text.indexOf("<img"));
    expect(img?.startTag.end).toBe(text.length);
  });

  it("records 1-based line and column (BOM not counted as a column)", () => {
    const page = parsePage('﻿<html>\n<body>\n  <img src="a.png">\n</body></html>');
    const img = page.elements.find((e) => e.tagName === "img");
    expect([img?.line, img?.col]).toEqual([3, 3]);
    const html = page.elements[0];
    expect([html?.line, html?.col]).toEqual([1, 1]);
  });
});

describe("document facts", () => {
  it("identifies the html ordinal, explicit </head> and titles", () => {
    const page = parsePage("<html><head><title> </title></head><body></body></html>");
    expect(page.htmlOrdinal).toBe(0);
    expect(page.head?.ordinal).toBe(1);
    const headEnd = page.head?.endTag ?? null;
    expect(headEnd === null ? null : slice(page, headEnd)).toBe("</head>");
    expect(page.titles.length).toBe(1);
    const t = page.titles[0];
    expect(t?.text).toBe(" ");
    const content = t?.contentRange ?? null;
    expect(content === null ? null : slice(page, content)).toBe(" ");
  });

  it("does not count SVG titles or titles inside templates", () => {
    const page = parsePage("<html><head></head><body><svg><title>icon</title></svg><template><title>x</title></template></body></html>");
    expect(page.titles.length).toBe(0);
  });

  it("counts ids over the document, excluding template contents", () => {
    const page = parsePage('<div id="a"></div><span id="a"></span><b id="b"></b><template><i id="a"></i></template>');
    expect(page.idCounts).toEqual({ a: 2, b: 1 });
  });

  it("excludes the inserted title from numbering on re-parse and gives it ordinal n", () => {
    const patched = "<html><head><title>New</title></head><body><p>x</p></body></html>";
    const start = patched.indexOf("<title>");
    const page = parsePage(patched, { insertedTitleStart: start });
    expect(tags(page)).toEqual(["html", "head", "body", "p", "title"]);
    expect(page.insertedTitleOrdinal).toBe(4);
    expect(page.elements[4]?.parentOrdinal).toBe(1);
  });
});

describe("element facts", () => {
  it("parses HTML integers", () => {
    expect(parseHtmlInteger(" 3")).toBe(3);
    expect(parseHtmlInteger("-1")).toBe(-1);
    expect(parseHtmlInteger("2abc")).toBe(2);
    expect(parseHtmlInteger("abc")).toBeNull();
    expect(parseHtmlInteger(null)).toBeNull();
  });

  // what_bug_this_catches: bounding the first 15 raw digits turned zero-prefixed positives into 0 and
  // negatives into -0, changing resolver eligibility and nonnegative-tabindex inventory membership.
  it.each([
    ["0000000000000003", 3],
    ["+0000000000000003", 3],
    ["-0000000000000001", -1],
    ["0000000000000000", 0],
    ["+0000000000000000", 0],
    ["-0000000000000000", -0],
    ["123456789012345678901234567890", 123456789012345],
    ["-123456789012345678901234567890", -123456789012345],
    ["000000000000000123456789012345678901234567890", 123456789012345],
    ["-000000000000000123456789012345678901234567890", -123456789012345],
  ] as const)("preserves sign and zero when bounding significant digits: %s", (value, expected) => {
    expect(parseHtmlInteger(value)).toBe(expected);
  });

  it("classifies native focusability, abstaining when undecidable", () => {
    const page = parsePage(
      '<a href="#">a</a><a onclick="x()">b</a><button>c</button><button disabled>d</button><div>e</div>' +
        '<input type="hidden"><input><fieldset disabled><input></fieldset><details><summary>s</summary></details><svg tabindex="1"></svg>',
    );
    const focus = page.elements.map((e) => {
      const entry = page.entries[e.entry];
      return entry === undefined ? "?" : `${e.tagName}:${nativeFocusability(entry)}`;
    });
    expect(focus).toEqual([
      "a:focusable",
      "a:undecidable",
      "button:focusable",
      "button:undecidable",
      "div:not_focusable",
      "input:undecidable",
      "input:focusable",
      "fieldset:not_focusable",
      "input:undecidable",
      "details:not_focusable",
      "summary:focusable",
      "svg:undecidable",
    ]);
  });
});
