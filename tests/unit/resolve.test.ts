// what_bug_this_catches: proposals writing outside their fingerprint target, silent title/heading repair on
// missing source anchors, dangling/duplicated name references, or tabindex repairs removing keyboard access.
// Dirty Mode: written, never run.
import { describe, expect, it } from "vitest";
import type { Op } from "../../src/shared/opsSchema.ts";
import { parsePage } from "../../src/core/html/parse.ts";
import { resolveOps } from "../../src/core/ops/resolve.ts";
import { applyResolved } from "../../src/core/ops/apply.ts";
import { checkInvariants } from "../../src/core/html/invariants.ts";

function resolve(source: string, rule: string, tag: string, make: (fingerprint: string) => Op[], nth = 0) {
  const page = parsePage(source);
  const ordinal = page.elements.filter((e) => e.tagName === tag)[nth]?.ordinal ?? 0;
  const fingerprint = `${rule}:${ordinal}`;
  return { page, outcome: resolveOps(page, { rule, fingerprint }, make(fingerprint)) };
}

function patched(source: string, rule: string, tag: string, make: (fingerprint: string) => Op[]) {
  const { page, outcome } = resolve(source, rule, tag, make);
  if (!outcome.ok) throw new Error(outcome.reasons.join(","));
  const applied = applyResolved(page, outcome.resolved);
  if (!applied.ok) throw new Error(applied.reason);
  expect(checkInvariants(page, outcome.resolved, applied).reasons).toEqual([]);
  return { applied, before: page, resolved: outcome.resolved };
}

describe("target binding and ambiguity", () => {
  it("changes only the selected one of identical siblings", () => {
    const source = '<img src="same.png"><img src="same.png">';
    const { page, outcome } = resolve(source, "image-alt", "img", (fingerprint) => [{ op: "set_attr", fingerprint, name: "alt", value: "Mountains" }], 1);
    if (!outcome.ok) throw new Error(outcome.reasons.join(","));
    expect(applyResolved(page, outcome.resolved)).toMatchObject({ ok: true, text: '<img src="same.png"><img src="same.png" alt="Mountains">' });
  });

  it("rejects a different op fingerprint, a matrix violation, or a template target", () => {
    expect(resolve("<img>", "image-alt", "img", () => [{ op: "mark_decorative", fingerprint: "image-alt:99" }]).outcome)
      .toMatchObject({ ok: false, state: "rejected", reasons: ["op_fingerprint_mismatch"] });
    expect(resolve("<img>", "image-alt", "img", (fingerprint) => [{ op: "set_attr", fingerprint, name: "lang", value: "en" }]).outcome)
      .toMatchObject({ ok: false, state: "rejected", reasons: ["op_not_allowed_for_rule"] });
    expect(resolve("<template><img></template>", "image-alt", "img", (fingerprint) => [{ op: "mark_decorative", fingerprint }]).outcome)
      .toMatchObject({ ok: false, state: "rejected", reasons: ["target_in_template"] });
  });

  it("abstains when a later body tag merged attributes into the tree", () => {
    const r = resolve('<html><head></head><body><body class="merged"></body></html>', "button-name", "body",
      (fingerprint) => [{ op: "set_attr", fingerprint, name: "aria-label", value: "Contents" }]);
    expect(r.outcome).toMatchObject({ ok: false, state: "abstain", reasons: ["attribute_scan_mismatch"] });
  });

  it("allows decorative empty alt only on an img", () => {
    expect(patched("<img alt=old>", "image-alt", "img", (fingerprint) => [{ op: "mark_decorative", fingerprint }]).applied.text).toBe('<img alt="">');
    expect(resolve("<div></div>", "image-alt", "div", (fingerprint) => [{ op: "mark_decorative", fingerprint }]).outcome)
      .toMatchObject({ ok: false, reasons: ["not_an_img"] });
  });
});

describe("document title", () => {
  const title = (fingerprint: string): Op[] => [{ op: "set_document_title", fingerprint, text: 'Café & "tea"' }];

  it("fills an existing whitespace-only title without adding an ordinal", () => {
    const { applied, before, resolved } = patched('<html><head><title> \n </title></head><body>é 😀</body></html>', "document-title", "html", title);
    expect(applied.text).toContain('<title>Café &amp; "tea"</title>');
    expect(resolved.insertsTitle).toBe(false);
    expect(parsePage(applied.text).elements.length).toBe(before.elements.length);
  });

  it("inserts before explicit head close, preserves BOM and non-ASCII, gives title ordinal n", () => {
    const source = '\ufeff<html><head></head><body>é 😀 <img></body></html>';
    const { applied, before } = patched(source, "document-title", "html", title);
    expect(applied.text).toBe('\ufeff<html><head><title>Café &amp; "tea"</title></head><body>é 😀 <img></body></html>');
    const after = parsePage(applied.text, { insertedTitleStart: applied.insertedTitleStart });
    expect(after.insertedTitleOrdinal).toBe(before.elements.length);
    expect(after.elements.slice(0, before.elements.length).map((e) => [e.tagName, e.parentOrdinal]))
      .toEqual(before.elements.map((e) => [e.tagName, e.parentOrdinal]));
  });

  it.each([
    '<head></head><body>x</body>', // implied html
    '<html><body>x</body></html>', // implied head
    '<html><head><body>x</body></html>', // no explicit head close
    '<html><title></title><body>x</body></html>', // implied head, even with empty title
    '<html><head><title></title><body>x</body></html>', // missing head close on fill path
    '<html><head><title></title><title></title></head><body></body></html>',
    '<html><head></head><body><title></title></body></html>', // misplaced title is not head metadata
  ])("refuses missing/ambiguous source metadata: %s", (source) => {
    expect(resolve(source, "document-title", "html", title).outcome).toMatchObject({ ok: false, state: "needs_human", reasons: ["implied_element"] });
  });

  it("refuses a non-empty title", () => {
    expect(resolve('<html><head><title>Existing</title></head><body></body></html>', "document-title", "html", title).outcome)
      .toMatchObject({ ok: false, state: "rejected", reasons: ["title_not_empty"] });
  });
});

describe("heading and tabindex preconditions", () => {
  it("retags both matching explicit names while preserving all other source bytes", () => {
    expect(patched('<H4 class="x">Hello</H4 >', "heading-order", "h4", (fingerprint) => [{ op: "retag_heading", fingerprint, level: 2 }]).applied.text)
      .toBe('<h2 class="x">Hello</h2 >');
  });

  it.each(["<h4>Hello", "<h4>Hello</h3>"])("refuses retagging without a matching explicit end tag: %s", (source) => {
    expect(resolve(source, "heading-order", "h4", (fingerprint) => [{ op: "retag_heading", fingerprint, level: 2 }]).outcome)
      .toMatchObject({ ok: false, state: "needs_human", reasons: ["no_end_tag"] });
  });

  // what_bug_this_catches: zero-prefixed positive tabindex was parsed as zero and a permitted repair rejected;
  // very large values must remain eligible on both native and non-native elements.
  it.each([
    "3",
    "0000000000000003",
    "+0000000000000003",
    "123456789012345678901234567890",
    "000000000000000123456789012345678901234567890",
  ])("repairs positive tabindex on native and non-native elements: %s", (value) => {
    expect(patched(`<button tabindex="${value}">Go</button>`, "tabindex", "button", (fingerprint) => [{ op: "remove_attr", fingerprint, name: "tabindex" }]).applied.text)
      .toBe('<button>Go</button>');
    expect(patched(`<div tabindex="${value}">Go</div>`, "tabindex", "div", (fingerprint) => [{ op: "set_attr", fingerprint, name: "tabindex", value: "0" }]).applied.text)
      .toBe('<div tabindex="0">Go</div>');
  });

  // what_bug_this_catches: fixing zero stripping must preserve the non-positive refusal for both repair ops,
  // including signed zero and negative integers beyond the finite-magnitude bound.
  it.each([
    "-0000000000000001",
    "0000000000000000",
    "+0000000000000000",
    "-0000000000000000",
    "-123456789012345678901234567890",
    "-000000000000000123456789012345678901234567890",
  ])("rejects non-positive tabindex on both repair paths: %s", (value) => {
    expect(resolve(`<button tabindex="${value}">Go</button>`, "tabindex", "button", (fingerprint) => [{ op: "remove_attr", fingerprint, name: "tabindex" }]).outcome)
      .toMatchObject({ ok: false, state: "rejected", reasons: ["tabindex_not_positive"] });
    expect(resolve(`<div tabindex="${value}">Go</div>`, "tabindex", "div", (fingerprint) => [{ op: "set_attr", fingerprint, name: "tabindex", value: "0" }]).outcome)
      .toMatchObject({ ok: false, state: "rejected", reasons: ["tabindex_not_positive"] });
  });

  it("abstains on undecidable focusability and rejects non-positive tabindex", () => {
    expect(resolve('<a tabindex="3" onclick="go()">Go</a>', "tabindex", "a", (fingerprint) => [{ op: "remove_attr", fingerprint, name: "tabindex" }]).outcome)
      .toMatchObject({ ok: false, state: "abstain", reasons: ["focusability_undecidable"] });
    expect(resolve('<button tabindex="0">Go</button>', "tabindex", "button", (fingerprint) => [{ op: "remove_attr", fingerprint, name: "tabindex" }]).outcome)
      .toMatchObject({ ok: false, state: "rejected", reasons: ["tabindex_not_positive"] });
  });
});

describe("aria-labelledby references", () => {
  it.each([
    ['<span id="name">Name</span><button></button>', true, null],
    ['<button></button>', false, "labelledby_id_missing"],
    ['<span id="name">A</span><b id="name">B</b><button></button>', false, "labelledby_id_duplicated"],
    ['<button id="name"></button>', false, "labelledby_self_reference"],
    ['<template><span id="name">Name</span></template><button></button>', false, "labelledby_id_missing"],
  ] as const)("requires unique non-self references: %s", (source, ok, reason) => {
    const { outcome } = resolve(source, "button-name", "button", (fingerprint) => [{ op: "set_attr", fingerprint, name: "aria-labelledby", value: "name" }]);
    expect(outcome.ok).toBe(ok);
    if (!outcome.ok) expect(outcome.reasons).toContain(reason);
  });
});
