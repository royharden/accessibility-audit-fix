// Local deterministic screen (PLAN.md 2.6, CL 2.8). Runs on every excerpt before any model call (client) and
// again in the edge function. It flags spans in visible text, comments and attribute values that address an
// AI/agent or give it instructions, replaces each flagged span with "[screened]", and returns the flagged spans so
// value gates can reject any proposed value that copies screened text. It does NOT flag ordinary URLs, `title`
// / `placeholder` values or other legitimate text merely because the page is untrusted.
// No safety claim: schemas, ordinal checks, canary rejection and invariants stay authoritative. Patterns are
// tuned on dev pages only (deferred). Edge-copied byte-identically; no imports.

export const SCREENED_MARKER = "[screened]";

export interface ScreenPattern {
  readonly id: string;
  readonly source: string;
}

/** Matched case-insensitively on an NFKC-normalised view with invisible format characters removed. */
export const SCREEN_PATTERNS: readonly ScreenPattern[] = Object.freeze([
  {
    // "ignore the rules", "disregard previous instructions" (verb, then an instruction noun within 60 chars).
    id: "ignore_instructions",
    source:
      String.raw`\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,60}?\b(?:instructions?|rules?|prompts?|guidelines?|directions?|constraints?|guardrails?)\b`,
  },
  {
    // Text that addresses an AI/agent: "you are an AI assistant", "dear AI", "AI reading this".
    id: "addresses_ai",
    source:
      String.raw`\byou\s+are\s+(?:now\s+)?(?:an?\s+|the\s+)?(?:ai(?:\s+(?:agent|model|assistant))?|assistant|chat\s?bot|language\s+model|llm|gpt|chatgpt|claude)\b` +
      String.raw`|\b(?:dear|hey|hello|attention|note\s+to(?:\s+the)?)\s+(?:ai|assistant|llm|chatgpt|claude|gpt|bot|crawler|scanner|fixer)\b` +
      String.raw`|\b(?:ai|llm|language\s+model)s?\s+(?:reading|processing|parsing|auditing)\s+this\b`,
  },
  {
    // "set aria-label to ...", "change the alt text to ...".
    id: "set_attribute_instruction",
    source:
      String.raw`\b(?:set|change|replace)\s+(?:the\s+)?(?:aria-label(?:ledby)?|alt(?:\s+text)?|title|lang(?:uage)?|accessible\s+name|label)(?:\s+attribute)?(?:\s*=|\s+(?:to|as)\b)`,
  },
  {
    id: "system_prompt",
    source: String.raw`\b(?:system\s+prompt|developer\s+(?:message|prompt))\b`,
  },
  {
    id: "role_marker",
    source: String.raw`(?:^|\n)\s*(?:system|assistant|developer)\s*:|<\|[a-z_]{2,20}\|>|\[\/?INST\]`,
  },
  {
    id: "canary_token",
    source: String.raw`\bCANARY-\w+`,
  },
]);

export interface ScreenSpan {
  /** UTF-16 offsets into the ORIGINAL input text. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly patternIds: readonly string[];
}

export interface ScreenResult {
  /** Input with every flagged span replaced by SCREENED_MARKER. */
  readonly text: string;
  readonly flagged: boolean;
  readonly spans: readonly ScreenSpan[];
}

const INVISIBLE = /^[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]$/;

interface CleanView {
  readonly clean: string;
  /** For each UTF-16 unit of `clean`: [start, end) of the originating code point in the original text. */
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

/** Per-code-point NFKC with invisible format characters dropped, keeping a map back to original offsets. */
function cleanView(text: string): CleanView {
  let clean = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const cp of text) {
    const start = offset;
    offset += cp.length;
    if (INVISIBLE.test(cp)) continue;
    const norm = cp.normalize("NFKC");
    for (let k = 0; k < norm.length; k++) {
      starts.push(start);
      ends.push(offset);
    }
    clean += norm;
  }
  return { clean, starts, ends };
}

interface RawMatch {
  start: number;
  end: number;
  id: string;
}

function findMatches(view: CleanView): RawMatch[] {
  const out: RawMatch[] = [];
  for (const pattern of SCREEN_PATTERNS) {
    const re = new RegExp(pattern.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(view.clean)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const s = view.starts[m.index];
      const e = view.ends[m.index + m[0].length - 1];
      if (s !== undefined && e !== undefined) out.push({ start: s, end: e, id: pattern.id });
    }
  }
  return out;
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

/** Grow a match to its enclosing sentence: bounded by a newline or by . ! ? followed by whitespace/end. */
function expandToSentence(text: string, start: number, end: number): [number, number] {
  let s = 0;
  for (let j = start - 1; j >= 0; j--) {
    const ch = text[j];
    if (ch === "\n") {
      s = j + 1;
      break;
    }
    if ((ch === "." || ch === "!" || ch === "?") && isSpace(text[j + 1])) {
      s = j + 1;
      break;
    }
  }
  while (s < start && isSpace(text[s])) s++;
  let e = text.length;
  for (let j = end; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\n") {
      e = j;
      break;
    }
    if ((ch === "." || ch === "!" || ch === "?") && isSpace(text[j + 1])) {
      e = j + 1;
      break;
    }
  }
  return [s, Math.max(e, end)];
}

export function screenText(text: string): ScreenResult {
  const matches = findMatches(cleanView(text));
  if (matches.length === 0) return { text, flagged: false, spans: [] };

  const expanded = matches
    .map((m) => {
      const [s, e] = expandToSentence(text, m.start, m.end);
      return { start: s, end: e, ids: [m.id] };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: { start: number; end: number; ids: string[] }[] = [];
  for (const span of expanded) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      for (const id of span.ids) if (!last.ids.includes(id)) last.ids.push(id);
    } else {
      merged.push({ start: span.start, end: span.end, ids: [...span.ids] });
    }
  }

  const spans: ScreenSpan[] = merged.map((m) => ({
    start: m.start,
    end: m.end,
    text: text.slice(m.start, m.end),
    patternIds: m.ids,
  }));

  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + SCREENED_MARKER;
    cursor = span.end;
  }
  out += text.slice(cursor);
  return { text: out, flagged: true, spans };
}

/** Screen several independent fields (visible text, comments, attribute values) at once. */
export function screenTexts(texts: readonly string[]): ScreenResult[] {
  return texts.map(screenText);
}

/** The flagged span texts of several screen results (input to the value gates' screened-span check). */
export function screenedSpanTexts(results: readonly ScreenResult[]): string[] {
  return results.flatMap((r) => r.spans.map((s) => s.text));
}

/** True when the value itself matches any screen pattern (used by the value gates on proposed values). */
export function matchesScreenPattern(value: string): boolean {
  return findMatches(cleanView(value)).length > 0;
}
