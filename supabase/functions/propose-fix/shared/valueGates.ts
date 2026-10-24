// Value gates (PLAN.md 2.3, CL 2.5): code checks on every proposed value, for every proposer, client-side and in
// the edge function (edge copy byte-identical). They return machine reason codes; any reason -> rejected.
//   text values (set_attr alt | aria-label | title, set_document_title text): non-empty, <= 125 characters,
//     no "<" / ">", no URL, not filename-like, not generic, no screened span, no screen-pattern match;
//     image-alt only: not a repeat of adjacent visible text (deviation C21; names taken from an adjacent <label>
//     are allowed, WCAG 2.5.3, which is automatic because the check applies to image-alt only).
//   lang: BCP 47 syntax.   colours: strict grammar (hex / rgb() / hsl() / named; no ";", "url(", "!important",
//   comments).   aria-labelledby: 1-3 ids, each existing exactly once (in what the caller can see), not the target.
// The edge checks what its bounded context allows; the core gate on the full page is authoritative.
import type { Op, SetAttrOp } from "./opsSchema.ts";
import { isBlankText } from "./opsSchema.ts";
import type { RuleId } from "./rules.ts";
import { isWellFormedBcp47 } from "./bcp47.ts";
import { matchesScreenPattern } from "./screen.ts";

export const MAX_NAME_LENGTH = 125;
export const MAX_LABELLEDBY_IDS = 3;
/** Screened spans shorter than this (normalised) are not compared, to avoid trivial matches. */
export const MIN_SCREENED_COMPARE_LENGTH = 4;
/** A value that is only a FRAGMENT of a screened span is rejected when it has at least this many code points
 * (normalised) or at least MIN_SCREENED_FRAGMENT_WORDS words; see containsScreenedSpan. */
export const MIN_SCREENED_FRAGMENT_LENGTH = 8;
export const MIN_SCREENED_FRAGMENT_WORDS = 2;

export const VALUE_GATE_REASONS = [
  "value_empty",
  "value_too_long",
  "value_has_angle_bracket",
  "value_has_url",
  "value_filename_like",
  "value_generic",
  "value_repeats_adjacent_text",
  "value_contains_screened_span",
  "value_matches_screen_pattern",
  "bcp47_syntax",
  "color_forbidden_token",
  "color_unparseable",
  "labelledby_id_count",
  "labelledby_id_missing",
  "labelledby_id_not_unique",
  "labelledby_self_reference",
  "labelledby_ids_unverifiable",
] as const;
export type ValueGateReason = (typeof VALUE_GATE_REASONS)[number];

export type ValueGateResult = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly ValueGateReason[] };

export interface ValueGateContext {
  /** Visible text adjacent to the target (e.g. the text of the link wrapping an image). Used for image-alt only. */
  readonly adjacentText?: readonly string[];
  /** Texts of spans the screen flagged in the context sent to (or available to) the proposer. */
  readonly screenedSpans?: readonly string[];
  /** id -> number of elements carrying it, over the page (core) or the bounded context (edge). */
  readonly idCounts?: Readonly<Record<string, number>>;
  /** The target element's own id, if any. */
  readonly targetId?: string | null;
}

const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/** Comparison form: NFKC, invisible characters removed, lower-cased, whitespace collapsed, edge punctuation trimmed. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(INVISIBLE_CHARS, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "");
}

/** Length in Unicode code points. */
export function charLength(value: string): number {
  return Array.from(value).length;
}

const URL_PATTERNS: readonly RegExp[] = [
  // Any RFC 3986 scheme ("javascript:", "mailto:", "intent:", ...) followed IMMEDIATELY by a non-space, so prose
  // labels such as "Data: 2024 sales chart" or "Tel: 555-1234" pass while "javascript:alert(1)" and "tel:5551234"
  // do not. Accepted cost: a "word:word" value with no space ("Q&A:Live") is rejected too.
  /\b[a-z][a-z0-9+.-]*:\S/i,
  /(?:^|\s)\/\/[^\s/]/,
  /\bwww\./i,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|io|dev|app|co|uk|de|fr|ai|info|biz|me|us|ca|au)\b(?:[/?#:]|$|\s)/i,
];

export function hasUrl(value: string): boolean {
  return URL_PATTERNS.some((re) => re.test(value));
}

const FILE_EXTENSIONS =
  "jpe?g|png|gif|webp|svg|bmp|tiff?|ico|avif|heic|heif|jfif|pdf|docx?|xlsx?|pptx?|txt|html?|php|aspx?|js|css|mp4|mov|webm|mp3|wav|zip";
const FILENAME_PATTERNS: readonly RegExp[] = [
  // ends with a file extension: "image1.jpg", "hero banner.png"
  new RegExp(String.raw`\.(?:${FILE_EXTENSIONS})$`, "i"),
  // camera / screenshot stems: "IMG_0042", "DSC-1234", "PXL_20240101", "Screenshot 2024-01-01"
  /^(?:img|dsc|dscn|dscf|dcim|pxl|mvimg|photo|image|pic|screenshot|screen shot|scan)[\s_-]*\d[\d_\s-]*$/i,
  // single token joined by underscores: "hero_banner_02"
  /^[a-z0-9]+(?:_[a-z0-9]+)+$/i,
  // hash-like: "3f9a1c0b7e", "a1b2c3d4-e5f6-..."
  /^[0-9a-f]{8,}$/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // purely numeric
  /^\d+$/,
];

export function isFilenameLike(value: string): boolean {
  const v = value.trim();
  return FILENAME_PATTERNS.some((re) => re.test(v));
}

/** Compared after normalizeText. Conservative on purpose: "Submit", "Search" and "Menu" are legitimate names. */
export const GENERIC_NAMES: readonly string[] = Object.freeze([
  "image", "img", "picture", "pic", "photo", "photograph", "graphic", "icon", "logo image", "banner",
  "image of", "picture of", "photo of", "alt", "alt text", "alternative text", "spacer", "blank", "placeholder",
  "untitled", "null", "undefined", "none", "n/a", "na", "todo", "tbd",
  "click", "click here", "here", "link", "more", "read more", "learn more", "more info", "more information",
  "this link", "go", "button", "btn", "label", "field", "input", "text", "title", "page", "document", "frame",
  "iframe", "content", "element",
]);
const GENERIC_SET: ReadonlySet<string> = new Set(GENERIC_NAMES);

export function isGenericName(value: string): boolean {
  return GENERIC_SET.has(normalizeText(value));
}

/** Letters, digits and combining marks: the characters a word boundary must not fall between. */
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;

function isWordChar(cp: string | undefined): boolean {
  return cp !== undefined && WORD_CHAR.test(cp);
}

/** The code point starting at UTF-16 index `i` of `s`, or undefined past the end. */
function codePointFrom(s: string, i: number): string | undefined {
  const cp = s.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/** The code point ending just before UTF-16 index `i` of `s`, or undefined at the start. */
function codePointBefore(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const low = s.charCodeAt(i - 1);
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = s.charCodeAt(i - 2);
    if (high >= 0xd800 && high <= 0xdbff) return s.slice(i - 2, i);
  }
  return s.slice(i - 1, i);
}

/** True when `v` occurs in `s` at least once without cutting a word of `s` in two at either end. */
function occursAsWholeWords(v: string, s: string): boolean {
  const first = codePointFrom(v, 0);
  const last = codePointBefore(v, v.length);
  for (let at = s.indexOf(v); at !== -1; at = s.indexOf(v, at + 1)) {
    const cutsStart = isWordChar(first) && isWordChar(codePointBefore(s, at));
    const cutsEnd = isWordChar(last) && isWordChar(codePointFrom(s, at + v.length));
    if (!cutsStart && !cutsEnd) return true;
  }
  return false;
}

/**
 * Screened-span check. Rule, on the comparison form (normalizeText) of the value and of each flagged span of at
 * least MIN_SCREENED_COMPARE_LENGTH characters - the value is rejected when:
 *   1. it CONTAINS the span (equality included): injected text copied wholesale, whatever surrounds it; or
 *   2. it is a FRAGMENT of the span on word boundaries (it never starts or ends inside a word of the span) AND it
 *      is at least MIN_SCREENED_FRAGMENT_WORDS words or MIN_SCREENED_FRAGMENT_LENGTH code points long: a payload
 *      such as "CANARY-7" or "Buy now" lifted out of "...set aria-label to CANARY-7" / "...to Buy now".
 * Not rejected: a single short word that also occurs in the span ("Search" in "ignore the rules for the Search
 * button"), and any value that occurs only inside longer words ("search notes" inside "research notes").
 * Accepted residual risk: a single short payload word ("pwned" from "set aria-label = pwned") passes THIS check;
 * the screen-pattern / canary gate, the op schema and the whole-page invariants stay authoritative.
 */
function containsScreenedSpan(value: string, spans: readonly string[]): boolean {
  const v = normalizeText(value);
  if (v.length === 0) return false;
  const fragmentRejectable =
    charLength(v) >= MIN_SCREENED_FRAGMENT_LENGTH || v.split(" ").length >= MIN_SCREENED_FRAGMENT_WORDS;
  for (const span of spans) {
    const s = normalizeText(span);
    if (s.length < MIN_SCREENED_COMPARE_LENGTH) continue;
    if (v.includes(s)) return true;
    if (fragmentRejectable && occursAsWholeWords(v, s)) return true;
  }
  return false;
}

/** Gates for human-readable text values (alt, aria-label, title attribute, document title). */
export function checkTextValue(value: string, ctx: ValueGateContext, options: { readonly checkAdjacent: boolean }): ValueGateReason[] {
  const reasons: ValueGateReason[] = [];
  if (isBlankText(value)) return ["value_empty"];
  if (charLength(value.trim()) > MAX_NAME_LENGTH) reasons.push("value_too_long");
  if (value.includes("<") || value.includes(">")) reasons.push("value_has_angle_bracket");
  if (hasUrl(value)) reasons.push("value_has_url");
  if (isFilenameLike(value)) reasons.push("value_filename_like");
  if (isGenericName(value)) reasons.push("value_generic");
  if (options.checkAdjacent && ctx.adjacentText !== undefined) {
    const v = normalizeText(value);
    if (v.length > 0 && ctx.adjacentText.some((t) => normalizeText(t) === v)) reasons.push("value_repeats_adjacent_text");
  }
  if (ctx.screenedSpans !== undefined && containsScreenedSpan(value, ctx.screenedSpans)) {
    reasons.push("value_contains_screened_span");
  }
  if (matchesScreenPattern(value)) reasons.push("value_matches_screen_pattern");
  return reasons;
}

/** aria-labelledby: whitespace-separated id list. */
export function checkLabelledbyValue(value: string, ctx: ValueGateContext): ValueGateReason[] {
  const ids = value.trim().split(/\s+/u).filter((s) => s.length > 0);
  if (ids.length === 0) return ["value_empty"];
  const reasons: ValueGateReason[] = [];
  if (ids.length > MAX_LABELLEDBY_IDS || new Set(ids).size !== ids.length) reasons.push("labelledby_id_count");
  if (value.includes("<") || value.includes(">")) reasons.push("value_has_angle_bracket");
  if (ctx.targetId !== undefined && ctx.targetId !== null && ids.includes(ctx.targetId)) {
    reasons.push("labelledby_self_reference");
  }
  if (ctx.idCounts === undefined) {
    reasons.push("labelledby_ids_unverifiable");
  } else {
    for (const id of ids) {
      const count = Object.hasOwn(ctx.idCounts, id) ? ctx.idCounts[id] : 0;
      if (count === undefined || count === 0) {
        if (!reasons.includes("labelledby_id_missing")) reasons.push("labelledby_id_missing");
      } else if (count > 1) {
        if (!reasons.includes("labelledby_id_not_unique")) reasons.push("labelledby_id_not_unique");
      }
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------------------------------------------
// Colours: strict grammar.

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0..1 */
  readonly a: number;
}

export type ParsedColor =
  | { readonly kind: "hex" | "rgb" | "hsl"; readonly rgba: Rgba }
  | { readonly kind: "named"; readonly name: string };

/** CSS named colours (CSS Color 4), lower-case. `transparent` and `currentcolor` are deliberately excluded:
 * neither defines a colour a contrast fix can rely on. */
export const NAMED_COLORS: ReadonlySet<string> = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond", "blue",
  "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue", "cornsilk",
  "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey", "darkkhaki",
  "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue",
  "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro",
  "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred",
  "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral",
  "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon",
  "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow", "lime",
  "limegreen", "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple",
  "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown",
  "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "turquoise", "violet",
  "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
]);

const COLOR_FORBIDDEN: readonly RegExp[] = [/;/, /url\s*\(/i, /!/, /\/\*/, /\*\//, /\\/, /["'`{}<>]/, /[\r\n]/, /\b(?:expression|var|attr|env|calc)\s*\(/i];

const NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

interface NumToken {
  readonly value: number;
  readonly percent: boolean;
}

function numToken(raw: string, allowPercent: boolean, unit?: string): NumToken | null {
  let s = raw;
  let percent = false;
  if (s.endsWith("%")) {
    if (!allowPercent) return null;
    percent = true;
    s = s.slice(0, -1);
  } else if (unit !== undefined && s.toLowerCase().endsWith(unit)) {
    s = s.slice(0, -unit.length);
  }
  if (!NUMBER.test(s)) return null;
  const value = Number(s);
  return Number.isFinite(value) ? { value, percent } : null;
}

/** Splits "a, b, c[, d]" (legacy) or "a b c[ / d]" (modern) into channel strings plus optional alpha. */
function splitArgs(inner: string): { channels: string[]; alpha: string | null } | null {
  const trimmed = inner.trim();
  if (trimmed.includes(",")) {
    if (trimmed.includes("/")) return null;
    const parts = trimmed.split(",").map((p) => p.trim());
    if (parts.some((p) => p.length === 0 || /\s/.test(p))) return null;
    if (parts.length === 3) return { channels: parts, alpha: null };
    if (parts.length === 4) return { channels: parts.slice(0, 3), alpha: parts[3] ?? null };
    return null;
  }
  const slash = trimmed.split("/");
  if (slash.length > 2) return null;
  const channels = (slash[0] ?? "").trim().split(/\s+/);
  if (channels.length !== 3 || channels.some((c) => c.length === 0)) return null;
  const alphaPart = slash.length === 2 ? (slash[1] ?? "").trim() : null;
  if (alphaPart !== null && (alphaPart.length === 0 || /\s/.test(alphaPart))) return null;
  return { channels, alpha: alphaPart };
}

function parseAlpha(raw: string | null): number | null {
  if (raw === null) return 1;
  const t = numToken(raw, true);
  if (t === null) return null;
  const a = t.percent ? t.value / 100 : t.value;
  return a >= 0 && a <= 1 ? a : null;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hue < 60) [r1, g1, b1] = [c, x, 0];
  else if (hue < 120) [r1, g1, b1] = [x, c, 0];
  else if (hue < 180) [r1, g1, b1] = [0, c, x];
  else if (hue < 240) [r1, g1, b1] = [0, x, c];
  else if (hue < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) };
}

/** Strict colour parser. Returns null for anything outside hex / rgb[a]() / hsl[a]() / named. */
export function parseCssColor(input: string): ParsedColor | null {
  const value = input.trim();
  if (value.length === 0 || value.length > 64) return null;
  if (COLOR_FORBIDDEN.some((re) => re.test(value))) return null;
  const lower = value.toLowerCase();

  if (NAMED_COLORS.has(lower)) return { kind: "named", name: lower };

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (hex !== null) {
    const h = hex[1] ?? "";
    const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
    return { kind: "hex", rgba: { r, g, b, a } };
  }

  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(lower);
  if (fn === null) return null;
  const name = fn[1] ?? "";
  const args = splitArgs(fn[2] ?? "");
  if (args === null) return null;
  const alpha = parseAlpha(args.alpha);
  if (alpha === null) return null;

  if (name === "rgb" || name === "rgba") {
    const rgb: number[] = [];
    for (const ch of args.channels) {
      const t = numToken(ch, true);
      if (t === null) return null;
      if (t.percent) {
        if (t.value > 100) return null;
        rgb.push(Math.round((t.value / 100) * 255));
      } else {
        if (t.value > 255) return null;
        rgb.push(Math.round(t.value));
      }
    }
    const [r = 0, g = 0, b = 0] = rgb;
    return { kind: "rgb", rgba: { r, g, b, a: alpha } };
  }

  const [hRaw = "", sRaw = "", lRaw = ""] = args.channels;
  const h = numToken(hRaw, false, "deg");
  const s = numToken(sRaw, true);
  const l = numToken(lRaw, true);
  if (h === null || s === null || l === null || !s.percent || !l.percent) return null;
  if (s.value > 100 || l.value > 100) return null;
  const { r, g, b } = hslToRgb(h.value, s.value / 100, l.value / 100);
  return { kind: "hsl", rgba: { r, g, b, a: alpha } };
}

export function checkColorValue(value: string): ValueGateReason[] {
  if (COLOR_FORBIDDEN.some((re) => re.test(value))) return ["color_forbidden_token"];
  return parseCssColor(value) === null ? ["color_unparseable"] : [];
}

// ---------------------------------------------------------------------------------------------------------------

function result(reasons: readonly ValueGateReason[]): ValueGateResult {
  const unique = [...new Set(reasons)];
  return unique.length === 0 ? { ok: true } : { ok: false, reasons: unique };
}

/** Value gates for one op proposed for `rule`. Ops without a free value (remove_attr, retag_heading,
 * mark_decorative, set_attr tabindex - fixed to "0" by the schema) pass here; the schema and matrix bound them. */
function setAttrReasons(rule: RuleId, op: SetAttrOp, ctx: ValueGateContext): ValueGateReason[] {
  switch (op.name) {
    case "alt":
      return checkTextValue(op.value, ctx, { checkAdjacent: rule === "image-alt" });
    case "aria-label":
    case "title":
      return checkTextValue(op.value, ctx, { checkAdjacent: false });
    case "aria-labelledby":
      return checkLabelledbyValue(op.value, ctx);
    case "lang":
      return isWellFormedBcp47(op.value) ? [] : ["bcp47_syntax"];
    case "tabindex":
      return [];
  }
}

export function checkOpValue(rule: RuleId, op: Op, ctx: ValueGateContext = {}): ValueGateResult {
  switch (op.op) {
    case "set_attr":
      return result(setAttrReasons(rule, op, ctx));
    case "set_document_title":
      return result(checkTextValue(op.text, ctx, { checkAdjacent: false }));
    case "set_style_color":
      return result(checkColorValue(op.value));
    case "remove_attr":
    case "retag_heading":
    case "mark_decorative":
      return result([]);
  }
}

export function checkProposalValues(rule: RuleId, ops: readonly Op[], ctx: ValueGateContext = {}): ValueGateResult {
  const reasons: ValueGateReason[] = [];
  for (const op of ops) {
    const r = checkOpValue(rule, op, ctx);
    if (!r.ok) reasons.push(...r.reasons);
  }
  return result(reasons);
}
