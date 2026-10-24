// BCP 47 (RFC 5646) well-formedness check for the `lang` value gate (PLAN.md 2.3).
// Syntax only: it does not consult the IANA subtag registry, so `xx-YY` is well-formed even if unregistered.
// Additionally rejects duplicate variants and duplicate extension singletons (RFC 5646 2.2.5/2.2.6 validity
// rules that need no registry). Edge-copied byte-identically; no imports.

export const MAX_BCP47_LENGTH = 64;

export type Bcp47Kind = "langtag" | "privateuse" | "grandfathered";

export interface Bcp47Parts {
  readonly kind: Bcp47Kind;
  /** Lower-cased input. */
  readonly tag: string;
  readonly language: string | null;
  readonly extlangs: readonly string[];
  readonly script: string | null;
  readonly region: string | null;
  readonly variants: readonly string[];
  readonly extensions: readonly string[];
  readonly privateuse: readonly string[];
}

export type Bcp47Result = { readonly ok: true; readonly parts: Bcp47Parts } | { readonly ok: false; readonly reason: "bcp47_syntax" };

/** RFC 5646 section 2.2.8, irregular and regular grandfathered tags (lower-cased). */
const GRANDFATHERED: ReadonlySet<string> = new Set([
  "en-gb-oed", "i-ami", "i-bnn", "i-default", "i-enochian", "i-hak", "i-klingon", "i-lux", "i-mingo", "i-navajo",
  "i-pwn", "i-tao", "i-tay", "i-tsu", "sgn-be-fr", "sgn-be-nl", "sgn-ch-de",
  "art-lojban", "cel-gaulish", "no-bok", "no-nyn", "zh-guoyu", "zh-hakka", "zh-min", "zh-min-nan", "zh-xiang",
]);

/** The raw input's alphabet, tested BEFORE any case folding. `String.prototype.toLowerCase` maps some non-ASCII
 * code points into ASCII (U+212A KELVIN SIGN -> "k"), so checking only the folded form would accept "\u212Aa" as
 * "ka". Deliberately no `i` flag: with `iu`, `[a-z]` also matches U+212A and U+017F under Unicode case folding. */
const RAW_TAG = /^[A-Za-z0-9-]+$/;
const ALPHA = /^[a-z]+$/;
const DIGIT = /^[0-9]+$/;
const ALNUM = /^[a-z0-9]+$/;

const FAIL: Bcp47Result = Object.freeze({ ok: false, reason: "bcp47_syntax" } as const);

function isAlpha(s: string, min: number, max: number): boolean {
  return s.length >= min && s.length <= max && ALPHA.test(s);
}

function isVariant(s: string): boolean {
  if (!ALNUM.test(s)) return false;
  if (s.length >= 5 && s.length <= 8) return true;
  return s.length === 4 && /^[0-9]/.test(s);
}

function isRegion(s: string): boolean {
  return isAlpha(s, 2, 2) || (s.length === 3 && DIGIT.test(s));
}

function isSingleton(s: string): boolean {
  return s.length === 1 && ALNUM.test(s) && s !== "x";
}

export function parseBcp47(input: string): Bcp47Result {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_BCP47_LENGTH) return FAIL;
  // ASCII-only gate on the raw input first; after it, toLowerCase() can only fold A-Z.
  if (!RAW_TAG.test(input)) return FAIL;
  const tag = input.toLowerCase();
  const subtags = tag.split("-");
  for (const s of subtags) {
    if (s.length < 1 || s.length > 8 || !ALNUM.test(s)) return FAIL;
  }

  if (GRANDFATHERED.has(tag)) {
    return {
      ok: true,
      parts: { kind: "grandfathered", tag, language: null, extlangs: [], script: null, region: null, variants: [], extensions: [], privateuse: [] },
    };
  }

  const at = (k: number): string | undefined => subtags[k];

  // privateuse-only tag: "x" 1*("-" 1*8alphanum)
  if (at(0) === "x") {
    const rest = subtags.slice(1);
    if (rest.length === 0) return FAIL;
    return {
      ok: true,
      parts: { kind: "privateuse", tag, language: null, extlangs: [], script: null, region: null, variants: [], extensions: [], privateuse: rest },
    };
  }

  // language = 2*3ALPHA ["-" extlang] / 4ALPHA / 5*8ALPHA ; extlang = 3ALPHA *2("-" 3ALPHA)
  const language = at(0);
  if (language === undefined || !isAlpha(language, 2, 8)) return FAIL;
  let i = 1;
  const extlangs: string[] = [];
  if (language.length <= 3) {
    while (extlangs.length < 3) {
      const s = at(i);
      if (s === undefined || !isAlpha(s, 3, 3)) break;
      extlangs.push(s);
      i++;
    }
  }

  let script: string | null = null;
  const maybeScript = at(i);
  if (maybeScript !== undefined && isAlpha(maybeScript, 4, 4)) {
    script = maybeScript;
    i++;
  }

  let region: string | null = null;
  const maybeRegion = at(i);
  if (maybeRegion !== undefined && isRegion(maybeRegion)) {
    region = maybeRegion;
    i++;
  }

  const variants: string[] = [];
  for (let s = at(i); s !== undefined && isVariant(s); s = at(i)) {
    if (variants.includes(s)) return FAIL;
    variants.push(s);
    i++;
  }

  // extension = singleton 1*("-" (2*8alphanum))
  const extensions: string[] = [];
  const singletons = new Set<string>();
  for (let s = at(i); s !== undefined && isSingleton(s); s = at(i)) {
    if (singletons.has(s)) return FAIL;
    singletons.add(s);
    i++;
    let count = 0;
    for (let t = at(i); t !== undefined && t.length >= 2 && ALNUM.test(t); t = at(i)) {
      count++;
      i++;
    }
    if (count === 0) return FAIL;
    extensions.push(subtags.slice(i - count - 1, i).join("-"));
  }

  // privateuse = "x" 1*("-" (1*8alphanum))
  let privateuse: string[] = [];
  if (at(i) === "x") {
    privateuse = subtags.slice(i + 1);
    if (privateuse.length === 0) return FAIL;
    i = subtags.length;
  }

  if (i !== subtags.length) return FAIL;
  return { ok: true, parts: { kind: "langtag", tag, language, extlangs, script, region, variants, extensions, privateuse } };
}

export function isWellFormedBcp47(input: string): boolean {
  return parseBcp47(input).ok;
}

/** Primary language subtag (lower-cased) or null for privateuse/grandfathered/invalid tags. */
export function primaryLanguage(input: string): string | null {
  const r = parseBcp47(input);
  return r.ok ? r.parts.language : null;
}
