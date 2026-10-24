// Text-level patch primitives (PLAN.md 2.2; CL 2.4 R2). Edits are offset splices into the ORIGINAL text (BOM
// included); the AST is never serialized back into source. This file knows HTML start-tag anatomy, attribute
// quoting and inline-style declarations, but nothing about ops: src/core/ops/resolve.ts maps ops to these
// primitives and src/core/ops/apply.ts applies them.
//
// Attribute rules (defined here, tested in tests/unit/patch.test.ts):
//   - insert: ` name="value"` right after the last attribute (or the tag name), so it lands before `>` / `/>` and
//     never inside an unquoted value (`<img src=a/>` keeps src="a/");
//   - replace: the value token (quotes included) becomes `"value"`; a valueless attribute gets `="value"` after
//     its name; unquoted and single-quoted values are therefore rewritten double-quoted;
//   - remove: the attribute plus the whitespace run before it;
//   - duplicates: the HTML tokenizer keeps the FIRST occurrence and drops the rest; an edit of an attribute name
//     that occurs more than once in the start tag is refused (`duplicate_attribute`), because removing or
//     replacing one copy can expose another;
//   - values are escaped `&` -> `&amp;`, `"` -> `&quot;` and always double-quoted.
import type { SourceRange } from "./parse.ts";

export const EDIT_PURPOSES = [
  "attr_insert",
  "attr_replace",
  "attr_remove",
  "style_edit",
  "retag_start",
  "retag_end",
  "title_fill",
  "title_insert",
] as const;
export type EditPurpose = (typeof EDIT_PURPOSES)[number];

/** One splice: replace original[start, end) with text. start === end is an insertion. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Ordinal of the element whose resolved range contains this edit (title fill: the <title>; title insert: the <head>). */
  readonly ordinal: number;
  /** The resolved range the edit must stay inside (invariant "edits only inside resolved ranges"). */
  readonly within: SourceRange;
  readonly purpose: EditPurpose;
}

export function escapeAttrValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** <title> is RCDATA: escape &, < and > so the text can neither start markup nor close the element early. */
export function escapeTitleText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------------------------------------------
// Edit geometry.

/**
 * Two edits conflict when their ranges overlap, when one inserts strictly inside the other, or when they start at
 * the same offset (two insertions at one point, or an insertion where a replacement starts: order ambiguous).
 * An insertion exactly at the end of another edit's range is not a conflict.
 */
export function editsConflict(a: Pick<Edit, "start" | "end">, b: Pick<Edit, "start" | "end">): boolean {
  if (a.start === b.start) return true;
  return a.start < b.end && b.start < a.end;
}

/** Index pairs [i, j] (i < j) of conflicting edits. */
export function findEditConflicts(edits: readonly Pick<Edit, "start" | "end">[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < edits.length; i++) {
    for (let j = i + 1; j < edits.length; j++) {
      const a = edits[i];
      const b = edits[j];
      if (a !== undefined && b !== undefined && editsConflict(a, b)) out.push([i, j]);
    }
  }
  return out;
}

export function editInBounds(edit: Pick<Edit, "start" | "end">, textLength: number, minStart = 0): boolean {
  return (
    Number.isSafeInteger(edit.start) &&
    Number.isSafeInteger(edit.end) &&
    edit.start >= minStart &&
    edit.end >= edit.start &&
    edit.end <= textLength
  );
}

/** Splice non-conflicting edits into text, highest start first. Caller guarantees bounds and no conflicts. */
export function spliceEdits(text: string, edits: readonly Pick<Edit, "start" | "end" | "text">[]): string {
  const sorted = [...edits].sort((x, y) => y.start - x.start || y.end - x.end);
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Where one applied edit landed. Ascending by start. */
export interface EditDelta {
  readonly start: number;
  readonly end: number;
  readonly newStart: number;
  readonly newEnd: number;
  /** text.length - (end - start). */
  readonly delta: number;
}

/** Deltas for non-conflicting edits, ascending by original start. */
export function computeDeltas(edits: readonly Pick<Edit, "start" | "end" | "text">[]): EditDelta[] {
  const sorted = [...edits].sort((x, y) => x.start - y.start || x.end - y.end);
  const out: EditDelta[] = [];
  let shift = 0;
  for (const e of sorted) {
    const delta = e.text.length - (e.end - e.start);
    out.push({ start: e.start, end: e.end, newStart: e.start + shift, newEnd: e.start + shift + e.text.length, delta });
    shift += delta;
  }
  return out;
}

/**
 * Map an original offset that lies outside every edited range to the patched text: shift by the deltas of every
 * edit that ends at or before it (an insertion exactly at the offset pushes the offset after the inserted text).
 * `left` affinity keeps a range end before an insertion exactly there (e.g. empty head/title content).
 * Returns null for an offset strictly inside a replaced range.
 */
export function mapOffset(deltas: readonly EditDelta[], offset: number, affinity: "left" | "right" = "right"): number | null {
  let shift = 0;
  for (const d of deltas) {
    if (d.start < offset && offset < d.end) return null;
    if (d.end <= offset && !(affinity === "left" && d.start === offset && d.end === offset)) shift += d.delta;
  }
  return offset + shift;
}

// ---------------------------------------------------------------------------------------------------------------
// Start-tag scanner: the HTML tokenizer's tag states (before/after attribute name, attribute name, before value,
// double/single-quoted and unquoted value, after quoted value, self-closing start tag), run over the exact
// source slice parse5 located. It records every attribute occurrence, duplicates included (parse5 drops them).

export interface RawAttr {
  /** ASCII-lower-cased name, as the tokenizer stores it. */
  readonly name: string;
  readonly nameStart: number;
  readonly nameEnd: number;
  /** Value token range including quotes; null for a valueless attribute. */
  readonly valueTokenStart: number | null;
  readonly valueTokenEnd: number | null;
  /** Value text range without quotes (raw, character references undecoded). */
  readonly valueStart: number | null;
  readonly valueEnd: number | null;
  readonly quote: '"' | "'" | null;
  /** End of the whole attribute (after the closing quote / unquoted value / name). */
  readonly end: number;
}

export interface StartTagScan {
  readonly range: SourceRange;
  readonly tagNameEnd: number;
  readonly attrs: readonly RawAttr[];
  /** Where a new attribute is inserted (after the last attribute, else after the tag name). */
  readonly insertAt: number;
  /** Offset of the closing `>`. */
  readonly closeIndex: number;
  readonly selfClosing: boolean;
}

function isWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Scan `text[range.start, range.end)`, which must be a whole start tag `<name ...>`. Null when it is not. */
export function scanStartTag(text: string, range: SourceRange): StartTagScan | null {
  const { start, end } = range;
  if (start < 0 || end > text.length || end - start < 3 || text.charAt(start) !== "<" || text.charAt(end - 1) !== ">") return null;
  let i = start + 1;
  const first = text.charAt(i);
  if (!/[A-Za-z]/.test(first)) return null;
  while (i < end && !isWs(text.charAt(i)) && text.charAt(i) !== "/" && text.charAt(i) !== ">") i++;
  const tagNameEnd = i;
  const attrs: RawAttr[] = [];
  let selfClosing = false;
  let closeIndex = -1;

  type State = "before_name" | "after_name" | "self_closing";
  let state: State = "before_name";
  while (i < end) {
    const ch = text.charAt(i);
    if (state === "self_closing") {
      if (ch === ">") {
        selfClosing = true;
        closeIndex = i;
        break;
      }
      state = "before_name"; // unexpected-solidus-in-tag: reconsume
      continue;
    }
    if (isWs(ch)) {
      i++;
      continue;
    }
    if (ch === ">") {
      closeIndex = i;
      break;
    }
    if (ch === "/") {
      state = "self_closing";
      i++;
      continue;
    }
    // Attribute name. A leading "=" is part of the name (unexpected-equals-sign-before-attribute-name).
    const nameStart = i;
    i++;
    while (i < end) {
      const c = text.charAt(i);
      if (isWs(c) || c === "/" || c === ">" || c === "=") break;
      i++;
    }
    const nameEnd = i;
    const name = asciiLower(text.slice(nameStart, nameEnd));
    // After attribute name.
    let j = i;
    while (j < end && isWs(text.charAt(j))) j++;
    if (text.charAt(j) !== "=") {
      attrs.push({ name, nameStart, nameEnd, valueTokenStart: null, valueTokenEnd: null, valueStart: null, valueEnd: null, quote: null, end: nameEnd });
      i = nameEnd;
      state = "after_name";
      // after_name: whitespace skipped by the loop; "/" -> self-closing; ">" -> emit; else a new attribute.
      continue;
    }
    // Before attribute value.
    j++;
    while (j < end && isWs(text.charAt(j))) j++;
    const q = text.charAt(j);
    if (q === ">" || j >= end) {
      // missing-attribute-value (`<a href=>`): legal to tokenize, but any insertion after the dangling "=" would
      // become that attribute's value. Refuse the whole tag (callers abstain: start_tag_scan_failed).
      return null;
    }
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, j + 1);
      if (close < 0 || close >= end) return null;
      attrs.push({
        name,
        nameStart,
        nameEnd,
        valueTokenStart: j,
        valueTokenEnd: close + 1,
        valueStart: j + 1,
        valueEnd: close,
        quote: q,
        end: close + 1,
      });
      i = close + 1;
      // after-attribute-value-quoted: whitespace / "/" / ">" handled by the loop; anything else is
      // missing-whitespace-between-attributes and reconsumed as a new attribute name - same as before_name.
      continue;
    }
    let k = j;
    while (k < end && !isWs(text.charAt(k)) && text.charAt(k) !== ">") k++;
    attrs.push({ name, nameStart, nameEnd, valueTokenStart: j, valueTokenEnd: k, valueStart: j, valueEnd: k, quote: null, end: k });
    i = k;
  }
  if (closeIndex !== end - 1) return null;
  const last = attrs[attrs.length - 1];
  return { range, tagNameEnd, attrs, insertAt: last === undefined ? tagNameEnd : last.end, closeIndex, selfClosing };
}

export function attrOccurrences(scan: StartTagScan, name: string): RawAttr[] {
  const lower = asciiLower(name);
  return scan.attrs.filter((a) => a.name === lower);
}

/** Unique attribute names in first-occurrence order (what the tree builder sees for an HTML element). */
export function uniqueAttrNames(scan: StartTagScan): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of scan.attrs) {
    if (!seen.has(a.name)) {
      seen.add(a.name);
      out.push(a.name);
    }
  }
  return out;
}

/** Raw source text of one attribute occurrence (name through value end). */
export function rawAttrText(text: string, attr: RawAttr): string {
  return text.slice(attr.nameStart, attr.end);
}

/** Raw (undecoded) value text of an attribute occurrence; "" for a valueless one. */
export function rawAttrValue(text: string, attr: RawAttr): string {
  return attr.valueStart === null || attr.valueEnd === null ? "" : text.slice(attr.valueStart, attr.valueEnd);
}

// ---------------------------------------------------------------------------------------------------------------
// Attribute edits.

export type AttrEditFailure = "duplicate_attribute" | "attribute_absent";

interface EditMeta {
  readonly ordinal: number;
}

/** Insert or replace `name="value"` in the start tag. */
export function setAttrEdit(scan: StartTagScan, name: string, value: string, meta: EditMeta): Edit | AttrEditFailure {
  const occ = attrOccurrences(scan, name);
  if (occ.length > 1) return "duplicate_attribute";
  const escaped = escapeAttrValue(value);
  const within = scan.range;
  const found = occ[0];
  if (found === undefined) {
    return { start: scan.insertAt, end: scan.insertAt, text: ` ${asciiLower(name)}="${escaped}"`, ordinal: meta.ordinal, within, purpose: "attr_insert" };
  }
  if (found.valueTokenStart === null || found.valueTokenEnd === null) {
    return { start: found.nameEnd, end: found.nameEnd, text: `="${escaped}"`, ordinal: meta.ordinal, within, purpose: "attr_replace" };
  }
  return { start: found.valueTokenStart, end: found.valueTokenEnd, text: `"${escaped}"`, ordinal: meta.ordinal, within, purpose: "attr_replace" };
}

/** Remove the attribute and the whitespace run before it. */
export function removeAttrEdit(text: string, scan: StartTagScan, name: string, meta: EditMeta): Edit | AttrEditFailure {
  const occ = attrOccurrences(scan, name);
  if (occ.length > 1) return "duplicate_attribute";
  const found = occ[0];
  if (found === undefined) return "attribute_absent";
  let s = found.nameStart;
  while (s > scan.tagNameEnd && isWs(text.charAt(s - 1))) s--;
  return { start: s, end: found.end, text: "", ordinal: meta.ordinal, within: scan.range, purpose: "attr_remove" };
}

// ---------------------------------------------------------------------------------------------------------------
// Inline style: one declaration per property inserted or replaced; every other declaration byte-preserved.

export interface StyleDeclaration {
  /** Offsets relative to the raw style value. */
  readonly start: number;
  readonly end: number;
  /** Trimmed, ASCII-lower-cased property name. */
  readonly property: string;
  /** Trimmed value range (relative), excluding a trailing `!important`. */
  readonly valueStart: number;
  readonly valueEnd: number;
}

/**
 * Split a raw style attribute value into declarations at top-level `;`. Returns null (abstain) when the value is
 * not simple enough to edit byte-safely: comments, backslash escapes, character references (`&`), `<`, braces,
 * unbalanced quotes or parentheses, or a non-empty segment without `:`.
 */
export function splitStyleDeclarations(raw: string): StyleDeclaration[] | null {
  if (raw.includes("/*") || raw.includes("\\") || raw.includes("&") || raw.includes("<") || /[{}]/.test(raw)) return null;
  const decls: StyleDeclaration[] = [];
  let segStart = 0;
  let quote: string | null = null;
  let depth = 0;
  let colon = -1;
  const finish = (segEnd: number): boolean => {
    const seg = raw.slice(segStart, segEnd);
    if (seg.trim() === "") return true;
    if (colon < 0) return false;
    const property = asciiLower(raw.slice(segStart, colon).trim());
    if (property === "") return false;
    let vs = colon + 1;
    let ve = segEnd;
    while (vs < ve && isWs(raw.charAt(vs))) vs++;
    while (ve > vs && isWs(raw.charAt(ve - 1))) ve--;
    const imp = /\s*!\s*important$/i.exec(raw.slice(vs, ve));
    if (imp !== null) ve -= imp[0].length;
    decls.push({ start: segStart, end: segEnd, property, valueStart: vs, valueEnd: ve });
    return true;
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return null;
    } else if (ch === ":" && depth === 0 && colon < 0) colon = i;
    else if (ch === ";" && depth === 0) {
      if (!finish(i)) return null;
      segStart = i + 1;
      colon = -1;
    }
  }
  if (quote !== null || depth !== 0) return null;
  if (!finish(raw.length)) return null;
  return decls;
}

export type StyleEditFailure = "duplicate_attribute" | "style_unparseable" | "duplicate_style_declaration" | "value_not_safe_for_style";

export type StyleRewrite =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: Exclude<StyleEditFailure, "duplicate_attribute"> };

export interface StyleSetting {
  readonly property: string;
  readonly value: string;
}

/** Characters a style value may never carry (the value gate is stricter; this keeps the splice well-formed). */
const UNSAFE_STYLE_VALUE = /[;"'<>&\\{}]|\/\*|url\(|!important|^\s*$/i;

/** Compute the new raw style value, or a failure. Exported for tests. */
export function rewriteStyleValue(raw: string, settings: readonly StyleSetting[]): StyleRewrite {
  if (new Set(settings.map((s) => s.property)).size !== settings.length) {
    return { ok: false, reason: "duplicate_style_declaration" };
  }
  for (const s of settings) {
    if (UNSAFE_STYLE_VALUE.test(s.value) || !/^[a-z-]+$/.test(s.property)) return { ok: false, reason: "value_not_safe_for_style" };
  }
  const decls = splitStyleDeclarations(raw);
  if (decls === null) return { ok: false, reason: "style_unparseable" };
  const replacements: { start: number; end: number; text: string }[] = [];
  const appends: string[] = [];
  for (const s of settings) {
    const matches = decls.filter((d) => d.property === s.property);
    if (matches.length > 1) return { ok: false, reason: "duplicate_style_declaration" };
    const m = matches[0];
    if (m === undefined) appends.push(`${s.property}: ${s.value.trim()}`);
    else replacements.push({ start: m.valueStart, end: m.valueEnd, text: s.value.trim() });
  }
  let out = spliceEdits(raw, replacements);
  if (appends.length > 0) {
    const addition = appends.join("; ");
    let te = out.length;
    while (te > 0 && isWs(out.charAt(te - 1))) te--;
    if (te === 0) out = addition;
    else {
      const sep = out.charAt(te - 1) === ";" ? " " : "; ";
      out = out.slice(0, te) + sep + addition + out.slice(te);
    }
  }
  return { ok: true, value: out };
}

/** One edit that sets 1-2 style properties on the element (merged so two ops never collide at one offset). */
export function styleEdit(text: string, scan: StartTagScan, settings: readonly StyleSetting[], meta: EditMeta): Edit | StyleEditFailure {
  const occ = attrOccurrences(scan, "style");
  if (occ.length > 1) return "duplicate_attribute";
  const found = occ[0];
  const within = scan.range;
  if (found === undefined) {
    const fresh = rewriteStyleValue("", settings);
    if (!fresh.ok) return fresh.reason;
    return { start: scan.insertAt, end: scan.insertAt, text: ` style="${escapeAttrValue(fresh.value)}"`, ordinal: meta.ordinal, within, purpose: "style_edit" };
  }
  const raw = rawAttrValue(text, found);
  if (found.quote === null && /["'`=<]/.test(raw)) return "style_unparseable";
  const rewritten = rewriteStyleValue(raw, settings);
  if (!rewritten.ok) return rewritten.reason;
  const next = rewritten.value;
  if (found.valueTokenStart === null || found.valueTokenEnd === null) {
    return { start: found.nameEnd, end: found.nameEnd, text: `="${escapeAttrValue(next)}"`, ordinal: meta.ordinal, within, purpose: "style_edit" };
  }
  if (found.quote === null) {
    return { start: found.valueTokenStart, end: found.valueTokenEnd, text: `"${escapeAttrValue(next)}"`, ordinal: meta.ordinal, within, purpose: "style_edit" };
  }
  // Quoted: replace the inner value only (other declarations keep their bytes; the quote style is kept).
  const vs = found.valueStart ?? found.valueTokenStart + 1;
  const ve = found.valueEnd ?? found.valueTokenEnd - 1;
  if (next.includes(found.quote)) return "value_not_safe_for_style";
  return { start: vs, end: ve, text: next, ordinal: meta.ordinal, within, purpose: "style_edit" };
}
