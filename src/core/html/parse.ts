// HTML parse, the ONE shared element walk, ordinals and source anchors (PLAN.md 2.2; CL 2.4 is normative).
//
// - parse5 with sourceCodeLocationInfo. parse.ts, renderCopy.ts and invariants.ts all go through walkTree()
//   (document pre-order, <template> content walked right after its <template> element) and assignAnchors().
// - Ordinals 0..n-1 go only to elements with a usable startTag source location. Elements without one are implied
//   (html/head/body/tbody/... absent from the text: `implied_element`) or parse-recovery clones
//   (`no_source_anchor`). parse5 re-materialises active formatting elements WITH the original token's location, so
//   a start tag that more than one element claims is ambiguous: none of those elements gets an ordinal
//   (`no_source_anchor`). A location whose text does not start with `<tagName` is also `no_source_anchor`.
// - BOM (CL F3): the original text keeps its BOM byte-for-byte; parse5 sees a view with one leading U+FEFF removed
//   and every offset is shifted by `bomDelta` (0 or 1 UTF-16 code unit) so ranges index the ORIGINAL text.
//   Offsets are UTF-16 code units, as parse5 reports them. Line/col (`cite`) are 1-based as parse5 reports them on
//   the BOM-stripped view, i.e. the editor view where the BOM is not a column.
// - Re-parse of a patched copy: pass `insertedTitleStart` (offset of the one inserted `<title>` in the patched
//   text); that element is excluded from numbering and gets ordinal n.
// src/core stays isomorphic: no node:*, no DOM globals.
import { parse as parse5Parse } from "parse5";

export const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";
export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/** Half-open [start, end) range of UTF-16 code units in the ORIGINAL text (BOM included). */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Minimal structural view of parse5's default tree (stable across parse5 7.x/8.x); the only cast is at the parse
// boundary below.

export interface P5Attr {
  name: string;
  value: string;
  namespace?: string;
  prefix?: string;
}

export interface P5Location {
  startLine: number;
  startCol: number;
  startOffset: number;
  endLine: number;
  endCol: number;
  endOffset: number;
}

export interface P5ElementLocation extends P5Location {
  startTag?: P5Location;
  endTag?: P5Location;
}

export interface P5Node {
  nodeName: string;
  parentNode?: P5Node | null;
  childNodes?: P5Node[];
}

export interface P5Element extends P5Node {
  tagName: string;
  namespaceURI: string;
  attrs: P5Attr[];
  childNodes: P5Node[];
  /** <template> only: the template contents fragment. */
  content?: P5Node;
  sourceCodeLocation?: P5ElementLocation | null;
}

export interface P5Text extends P5Node {
  nodeName: "#text";
  value: string;
}

export interface P5Document extends P5Node {
  childNodes: P5Node[];
}

export function isElementNode(node: P5Node): node is P5Element {
  return typeof (node as Partial<P5Element>).tagName === "string" && Array.isArray((node as Partial<P5Element>).attrs);
}

export function isTextNode(node: P5Node): node is P5Text {
  return node.nodeName === "#text" && typeof (node as Partial<P5Text>).value === "string";
}

/** Child nodes of a node; for <template>, the children of its content fragment. */
export function childrenOf(node: P5Node): readonly P5Node[] {
  if (isElementNode(node) && node.content !== undefined) return node.content.childNodes ?? [];
  return node.childNodes ?? [];
}

export const PARSE5_OPTIONS = { sourceCodeLocationInfo: true, scriptingEnabled: true } as const;

/** parse5 never throws on input text; the try/catch in parsePage is defensive. */
export function parseTree(view: string): P5Document {
  return parse5Parse(view, PARSE5_OPTIONS) as unknown as P5Document;
}

// ---------------------------------------------------------------------------------------------------------------
// The one shared walk.

export interface WalkEntry {
  /** Pre-order index among all elements of the document (template contents included). */
  readonly index: number;
  readonly node: P5Element;
  readonly tagName: string;
  readonly namespace: string;
  /** Walk index of the nearest element ancestor (the <template> element for template contents); null at the root. */
  readonly parentIndex: number | null;
  readonly depth: number;
  /** Inside some <template>'s contents (not part of the rendered document). */
  readonly inTemplate: boolean;
  /** A <fieldset disabled> is an ancestor (legend exception not modelled: focusability -> undecidable). */
  readonly underDisabledFieldset: boolean;
  /** An ancestor carries `inert`. */
  readonly underInert: boolean;
  /** The first <summary> element child of a <details> (natively focusable). */
  readonly firstSummaryOfDetails: boolean;
}

interface WalkFrame {
  readonly node: P5Node;
  readonly parentIndex: number | null;
  readonly depth: number;
  readonly inTemplate: boolean;
  readonly underDisabledFieldset: boolean;
  readonly underInert: boolean;
  readonly firstSummaryOfDetails: boolean;
}

function hasAttrNamed(el: P5Element, name: string): boolean {
  return el.attrs.some((a) => a.prefix === undefined && a.name === name);
}

/**
 * Document pre-order over every element, template contents included (walked immediately after the <template>
 * element, as its descendants). Iterative, so deep documents cannot overflow the stack.
 */
export function walkTree(tree: P5Document): WalkEntry[] {
  const entries: WalkEntry[] = [];
  const stack: WalkFrame[] = [];
  const pushChildren = (
    node: P5Node,
    parentIndex: number | null,
    depth: number,
    inTemplate: boolean,
    underDisabledFieldset: boolean,
    underInert: boolean,
  ): void => {
    const children = childrenOf(node);
    const isDetails = isElementNode(node) && node.namespaceURI === HTML_NS && node.tagName === "details";
    let seenSummary = false;
    const frames: WalkFrame[] = [];
    for (const child of children) {
      if (!isElementNode(child)) continue;
      let firstSummary = false;
      if (isDetails && child.namespaceURI === HTML_NS && child.tagName === "summary" && !seenSummary) {
        seenSummary = true;
        firstSummary = true;
      }
      frames.push({ node: child, parentIndex, depth, inTemplate, underDisabledFieldset, underInert, firstSummaryOfDetails: firstSummary });
    }
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if (frame !== undefined) stack.push(frame);
    }
  };

  pushChildren(tree, null, 0, false, false, false);
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined || !isElementNode(frame.node)) continue;
    const el = frame.node;
    const index = entries.length;
    entries.push({
      index,
      node: el,
      tagName: el.tagName,
      namespace: el.namespaceURI,
      parentIndex: frame.parentIndex,
      depth: frame.depth,
      inTemplate: frame.inTemplate,
      underDisabledFieldset: frame.underDisabledFieldset,
      underInert: frame.underInert,
      firstSummaryOfDetails: frame.firstSummaryOfDetails,
    });
    const isHtml = el.namespaceURI === HTML_NS;
    const isTemplate = isHtml && el.tagName === "template" && el.content !== undefined;
    pushChildren(
      el,
      index,
      frame.depth + 1,
      frame.inTemplate || isTemplate,
      frame.underDisabledFieldset || (isHtml && el.tagName === "fieldset" && hasAttrNamed(el, "disabled")),
      frame.underInert || hasAttrNamed(el, "inert"),
    );
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------------------------
// Anchors and ordinals.

/** Why an element has no ordinal (subset of UnmappedReason in src/core/audit/types.ts). */
export type UnanchoredReason = "implied_element" | "no_source_anchor";

/** HTML active-formatting elements: the only elements parse5 re-creates as recovery clones. */
export const FORMATTING_ELEMENTS: ReadonlySet<string> = new Set([
  "a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u",
]);

export interface ElementAttr {
  /** Lower-case as parse5 reports it; foreign attributes keep their prefix (`xlink:href`). */
  readonly name: string;
  /** Decoded value (character references resolved by parse5). */
  readonly value: string;
}

export interface ElementRecord {
  readonly ordinal: number;
  /** Index into ParsedPage.entries. */
  readonly entry: number;
  readonly tagName: string;
  readonly namespace: string;
  readonly startTag: SourceRange;
  /** Explicit end tag whose name matches (parse5 sets it only then), else null. */
  readonly endTag: SourceRange | null;
  /** Nearest ordinal-bearing element ancestor (template element for template contents), else null. */
  readonly parentOrdinal: number | null;
  /** 1-based, editor view (BOM not counted). */
  readonly line: number;
  readonly col: number;
  readonly inTemplate: boolean;
  readonly attrs: readonly ElementAttr[];
}

export interface UnanchoredRecord {
  readonly entry: number;
  readonly tagName: string;
  readonly namespace: string;
  readonly reason: UnanchoredReason;
  readonly parentOrdinal: number | null;
  readonly inTemplate: boolean;
}

export interface HeadInfo {
  readonly entry: number;
  readonly ordinal: number | null;
  /** Explicit `</head>` that closed the head element. */
  readonly endTag: SourceRange | null;
}

export interface TitleInfo {
  readonly entry: number;
  readonly ordinal: number | null;
  /** Decoded text content. */
  readonly text: string;
  /** [end of start tag, start of end tag) when both tags are explicit and the element has an ordinal. */
  readonly contentRange: SourceRange | null;
}

export interface ParsedPage {
  /** Exactly the input text (BOM included). */
  readonly original: string;
  /** The text parse5 parsed (one leading U+FEFF removed). */
  readonly view: string;
  readonly bomDelta: 0 | 1;
  readonly tree: P5Document;
  readonly entries: readonly WalkEntry[];
  /** Per walk entry: its ordinal, or null. */
  readonly entryOrdinals: readonly (number | null)[];
  /** Per walk entry: why it has no ordinal, or null when it has one. */
  readonly entryReasons: readonly (UnanchoredReason | null)[];
  /** Indexed by ordinal: elements[i].ordinal === i. */
  readonly elements: readonly ElementRecord[];
  readonly unanchored: readonly UnanchoredRecord[];
  /** The document's root <html> element's ordinal (null when implied). */
  readonly htmlOrdinal: number | null;
  readonly htmlReason: UnanchoredReason | null;
  readonly head: HeadInfo | null;
  readonly bodyEntry: number | null;
  /** HTML-namespace <title> elements outside template contents, in document order. */
  readonly titles: readonly TitleInfo[];
  /** id -> number of elements carrying it (document only, template contents excluded; clones included). */
  readonly idCounts: Readonly<Record<string, number>>;
  /** Ordinal of the excluded inserted <title> (re-parse only), else null. */
  readonly insertedTitleOrdinal: number | null;
}

export interface ParseOptions {
  /** Re-parse of a patched copy: start offset (patched text, BOM included) of the one inserted <title>. */
  readonly insertedTitleStart?: number | null;
}

export function bomDeltaOf(text: string): 0 | 1 {
  return text.charCodeAt(0) === 0xfeff ? 1 : 0;
}

function isTagNameTerminator(ch: string): boolean {
  return ch === "" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "/" || ch === ">";
}

/** The start tag's range in the original text, or null when the location is missing or does not check out. */
function locatedStartTag(entry: WalkEntry, original: string, bomDelta: number): SourceRange | "missing" | "mismatch" {
  const st = entry.node.sourceCodeLocation?.startTag;
  if (st === undefined || st === null) return "missing";
  const start = st.startOffset + bomDelta;
  const end = st.endOffset + bomDelta;
  if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end)) || start < bomDelta || end <= start || end > original.length) {
    return "mismatch";
  }
  if (original.charAt(start) !== "<" || original.charAt(end - 1) !== ">") return "mismatch";
  const nameEnd = start + 1 + entry.tagName.length;
  if (original.slice(start + 1, nameEnd).toLowerCase() !== entry.tagName.toLowerCase()) return "mismatch";
  if (!isTagNameTerminator(original.charAt(nameEnd))) return "mismatch";
  return { start, end };
}

function locatedEndTag(entry: WalkEntry, original: string, bomDelta: number): SourceRange | null {
  const et = entry.node.sourceCodeLocation?.endTag;
  if (et === undefined || et === null) return null;
  const start = et.startOffset + bomDelta;
  const end = et.endOffset + bomDelta;
  if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end)) || start < bomDelta || end <= start || end > original.length) {
    return null;
  }
  if (original.slice(start, start + 2) !== "</" || original.charAt(end - 1) !== ">") return null;
  const nameEnd = start + 2 + entry.tagName.length;
  if (original.slice(start + 2, nameEnd).toLowerCase() !== entry.tagName.toLowerCase()) return null;
  if (!isTagNameTerminator(original.charAt(nameEnd))) return null;
  return { start, end };
}

export interface AnchorAssignment {
  readonly entryOrdinals: (number | null)[];
  readonly entryReasons: (UnanchoredReason | null)[];
  readonly startTags: (SourceRange | null)[];
  readonly insertedTitleOrdinal: number | null;
}

/**
 * Ordinal assignment over a walk (used by parsePage, hence by renderCopy and invariants). Elements whose start tag
 * is claimed by more than one element are all left without an ordinal (ambiguous anchor).
 */
export function assignAnchors(
  entries: readonly WalkEntry[],
  original: string,
  bomDelta: number,
  insertedTitleStart: number | null,
): AnchorAssignment {
  const located: (SourceRange | "missing" | "mismatch")[] = entries.map((e) => locatedStartTag(e, original, bomDelta));
  const claims = new Map<number, number>();
  for (const loc of located) {
    if (typeof loc === "object") claims.set(loc.start, (claims.get(loc.start) ?? 0) + 1);
  }
  const entryOrdinals: (number | null)[] = [];
  const entryReasons: (UnanchoredReason | null)[] = [];
  const startTags: (SourceRange | null)[] = [];
  let next = 0;
  let excludedEntry: number | null = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const loc = located[i];
    if (entry === undefined || loc === undefined || loc === "missing") {
      const clone = entry !== undefined && entry.namespace === HTML_NS && FORMATTING_ELEMENTS.has(entry.tagName);
      entryOrdinals.push(null);
      entryReasons.push(clone ? "no_source_anchor" : "implied_element");
      startTags.push(null);
      continue;
    }
    if (loc === "mismatch" || (claims.get(loc.start) ?? 0) > 1) {
      entryOrdinals.push(null);
      entryReasons.push("no_source_anchor");
      startTags.push(null);
      continue;
    }
    startTags.push(loc);
    entryReasons.push(null);
    if (
      insertedTitleStart !== null &&
      excludedEntry === null &&
      loc.start === insertedTitleStart &&
      entry.namespace === HTML_NS &&
      entry.tagName === "title"
    ) {
      excludedEntry = i;
      entryOrdinals.push(null); // filled with n below
      continue;
    }
    entryOrdinals.push(next++);
  }
  let insertedTitleOrdinal: number | null = null;
  if (excludedEntry !== null) {
    insertedTitleOrdinal = next;
    entryOrdinals[excludedEntry] = next;
  }
  return { entryOrdinals, entryReasons, startTags, insertedTitleOrdinal };
}

function nearestOrdinalAncestor(entries: readonly WalkEntry[], ordinals: readonly (number | null)[], index: number): number | null {
  let p = entries[index]?.parentIndex ?? null;
  while (p !== null) {
    const ord = ordinals[p];
    if (ord !== null && ord !== undefined) return ord;
    p = entries[p]?.parentIndex ?? null;
  }
  return null;
}

function recordAttrs(el: P5Element): ElementAttr[] {
  return el.attrs.map((a) => ({ name: a.prefix !== undefined && a.prefix !== "" ? `${a.prefix}:${a.name}` : a.name, value: a.value }));
}

/** Concatenated text of all descendant text nodes (template contents included for a <template>). */
export function textContent(node: P5Node): string {
  let out = "";
  const stack: P5Node[] = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) continue;
    if (isTextNode(n)) {
      out += n.value;
      continue;
    }
    const kids = childrenOf(n);
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k !== undefined) stack.push(k);
    }
  }
  return out;
}

export class HtmlParseError extends Error {
  readonly code = "reparse_failed";
}

/** Parse once with locations and build every anchor table. Throws HtmlParseError only if parse5 itself throws. */
export function parsePage(original: string, options: ParseOptions = {}): ParsedPage {
  const bomDelta = bomDeltaOf(original);
  const view = bomDelta === 1 ? original.slice(1) : original;
  let tree: P5Document;
  try {
    tree = parseTree(view);
  } catch (e) {
    throw new HtmlParseError(e instanceof Error ? e.message : String(e));
  }
  const entries = walkTree(tree);
  const anchors = assignAnchors(entries, original, bomDelta, options.insertedTitleStart ?? null);
  const { entryOrdinals, entryReasons, startTags } = anchors;

  const elements: ElementRecord[] = [];
  const unanchored: UnanchoredRecord[] = [];
  entries.forEach((entry, i) => {
    const ordinal = entryOrdinals[i] ?? null;
    const parentOrdinal = nearestOrdinalAncestor(entries, entryOrdinals, i);
    const startTag = startTags[i] ?? null;
    if (ordinal === null || startTag === null) {
      unanchored.push({
        entry: i,
        tagName: entry.tagName,
        namespace: entry.namespace,
        reason: entryReasons[i] ?? "no_source_anchor",
        parentOrdinal,
        inTemplate: entry.inTemplate,
      });
      return;
    }
    const st = entry.node.sourceCodeLocation?.startTag;
    elements[ordinal] = {
      ordinal,
      entry: i,
      tagName: entry.tagName,
      namespace: entry.namespace,
      startTag,
      endTag: locatedEndTag(entry, original, bomDelta),
      parentOrdinal,
      line: st?.startLine ?? 1,
      col: st?.startCol ?? 1,
      inTemplate: entry.inTemplate,
      attrs: recordAttrs(entry.node),
    };
  });

  // Root <html>, its <head> and <body> (direct element children of the document / of <html>).
  let htmlEntry: number | null = null;
  let headEntry: number | null = null;
  let bodyEntry: number | null = null;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined || entry.namespace !== HTML_NS || entry.inTemplate) continue;
    if (entry.parentIndex === null && entry.tagName === "html" && htmlEntry === null) htmlEntry = i;
    else if (htmlEntry !== null && entry.parentIndex === htmlEntry) {
      if (entry.tagName === "head" && headEntry === null) headEntry = i;
      else if (entry.tagName === "body" && bodyEntry === null) bodyEntry = i;
    }
  }
  const htmlOrdinal = htmlEntry === null ? null : (entryOrdinals[htmlEntry] ?? null);
  const htmlReason = htmlEntry === null ? "implied_element" : htmlOrdinal === null ? (entryReasons[htmlEntry] ?? "implied_element") : null;

  let head: HeadInfo | null = null;
  if (headEntry !== null) {
    const he = entries[headEntry];
    head = {
      entry: headEntry,
      ordinal: entryOrdinals[headEntry] ?? null,
      endTag: he === undefined ? null : locatedEndTag(he, original, bomDelta),
    };
  }

  const titles: TitleInfo[] = [];
  const idCountMap = new Map<string, number>();
  entries.forEach((entry, i) => {
    if (entry.inTemplate) return;
    for (const a of entry.node.attrs) {
      if (a.name === "id" && a.prefix === undefined && a.value !== "") idCountMap.set(a.value, (idCountMap.get(a.value) ?? 0) + 1);
    }
    if (entry.namespace !== HTML_NS || entry.tagName !== "title") return;
    const ordinal = entryOrdinals[i] ?? null;
    const record = ordinal === null ? undefined : elements[ordinal];
    const contentRange =
      record !== undefined && record.endTag !== null && record.endTag.start >= record.startTag.end
        ? { start: record.startTag.end, end: record.endTag.start }
        : null;
    titles.push({ entry: i, ordinal, text: textContent(entry.node), contentRange });
  });

  return {
    original,
    view,
    bomDelta,
    tree,
    entries,
    entryOrdinals,
    entryReasons,
    elements,
    unanchored,
    htmlOrdinal,
    htmlReason,
    head,
    bodyEntry,
    titles,
    idCounts: Object.fromEntries(idCountMap),
    insertedTitleOrdinal: anchors.insertedTitleOrdinal,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Element facts shared by resolve (tabindex preconditions) and invariants (interactive inventory).

export function getAttr(entry: WalkEntry, name: string): string | null {
  for (const a of entry.node.attrs) {
    if ((a.prefix === undefined || a.prefix === "") && a.name === name) return a.value;
  }
  return null;
}

/** HTML "rules for parsing integers": leading ASCII whitespace, optional sign, digits; trailing text ignored. */
export function parseHtmlInteger(value: string | null): number | null {
  if (value === null) return null;
  const m = /^[\t\n\f\r ]*([+-]?)([0-9]+)/.exec(value);
  if (m === null) return null;
  // Bound significant digits only: leading zeroes must not turn a nonzero value into +/-0. Consumers
  // need the sign/zero classification; the bound keeps very large magnitudes finite and exactly representable.
  const digits = (m[2] ?? "").replace(/^0+/, "") || "0";
  const n = Number(digits.length > 15 ? digits.slice(0, 15) : digits);
  return m[1] === "-" ? -n : n;
}

/** `on*` event-handler content attribute name (lower-case comparison). */
export function isHandlerAttrName(name: string): boolean {
  return /^on[a-z]/i.test(name);
}

export type Focusability = "focusable" | "not_focusable" | "undecidable";

/**
 * Native (tabindex-independent) focusability, PLAN.md 2.3. `undecidable` makes tabindex ops abstain rather than
 * risk removing keyboard access: <a>/<area> without href, disabled or fieldset-disabled controls, input
 * type=hidden, media without controls, object/embed, non-first <summary>, editing hosts, inert subtrees,
 * foreign (SVG/MathML) elements and template contents.
 */
export function nativeFocusability(entry: WalkEntry): Focusability {
  if (entry.inTemplate || entry.underInert || getAttr(entry, "inert") !== null) return "undecidable";
  if (entry.namespace !== HTML_NS) return "undecidable";
  const disabled = getAttr(entry, "disabled") !== null || entry.underDisabledFieldset;
  switch (entry.tagName) {
    case "a":
    case "area":
      return getAttr(entry, "href") !== null ? "focusable" : "undecidable";
    case "button":
    case "select":
    case "textarea":
      return disabled ? "undecidable" : "focusable";
    case "input": {
      const type = (getAttr(entry, "type") ?? "").trim().toLowerCase();
      if (type === "hidden" || disabled) return "undecidable";
      return "focusable";
    }
    case "iframe":
      return "focusable";
    case "summary":
      return entry.firstSummaryOfDetails ? "focusable" : "undecidable";
    case "audio":
    case "video":
      return getAttr(entry, "controls") !== null ? "focusable" : "undecidable";
    case "object":
    case "embed":
    case "frame":
      return "undecidable";
    default: {
      const ce = getAttr(entry, "contenteditable");
      if (ce !== null && ce.trim().toLowerCase() !== "false") return "undecidable";
      return "not_focusable";
    }
  }
}

/** The walk entry of an ordinal-bearing element. */
export function entryOf(page: ParsedPage, ordinal: number): WalkEntry | undefined {
  const rec = page.elements[ordinal];
  return rec === undefined ? undefined : page.entries[rec.entry];
}
