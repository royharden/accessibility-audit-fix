// Strict gate (c): code invariants between the unpatched page and the patched copy (PLAN.md 2.4(c); CL 2.6, F5).
//
//   1. the patch is exactly the resolved edits spliced into the original, each edit inside its resolved range
//      (target start tag, matching end tag, empty <title> content, or the point before an explicit </head>), and
//      the BOM is untouched;
//   2. the re-parse succeeds with the same walk; the one inserted <title> is excluded and gets ordinal n;
//   3. source-located element sequence and count unchanged (tag, namespace, parent ordinal, template membership,
//      start offsets shifted by exactly the known edit deltas) except the retag target's tag and the one <title>;
//      unanchored (implied / clone) elements unchanged;
//   4. visible body text unchanged (title is head metadata);
//   5. interactive inventory unchanged (one function: native interactive + tabindex >= 0 + handler attributes;
//      role and focusability preserved);
//   6. id multiplicities unchanged and no new duplicate id;
//   7. <script> elements and on* attributes byte-identical;
//   8. each op's effect is observable in the re-parse (attribute value / removal, document title text).
// Every failure is a machine reason code; the checker never throws.
import type { Focusability, ParsedPage, SourceRange } from "./parse.ts";
import {
  HTML_NS,
  bomDeltaOf,
  getAttr,
  isElementNode,
  isHandlerAttrName,
  isTextNode,
  nativeFocusability,
  parseHtmlInteger,
  parsePage,
  textContent,
} from "./parse.ts";
import type { Edit, EditDelta } from "./patch.ts";
import { computeDeltas, editInBounds, findEditConflicts, mapOffset, rawAttrText, scanStartTag, spliceEdits } from "./patch.ts";

export const INVARIANT_REASONS = [
  "bom_changed",
  "patch_mismatch",
  "edit_outside_resolved_range",
  "reparse_failed",
  "inserted_title_not_found",
  "element_count_changed",
  "element_sequence_changed",
  "element_offset_mismatch",
  "retag_target_mismatch",
  "unanchored_elements_changed",
  "visible_text_changed",
  "interactive_inventory_changed",
  "id_multiplicity_changed",
  "new_duplicate_id",
  "script_changed",
  "handler_attr_changed",
  "op_effect_not_observed",
  "title_text_not_observed",
] as const;
export type InvariantReason = (typeof INVARIANT_REASONS)[number];

/** What the resolver promised (structurally satisfied by ops/resolve.ts ResolvedOps). */
export interface PatchDescription {
  readonly edits: readonly Edit[];
  readonly retag: { readonly ordinal: number; readonly tagName: string } | null;
  /** Combined export only: disjoint retags; the existing single-fix retag field remains supported. */
  readonly retags?: readonly { readonly ordinal: number; readonly tagName: string }[];
  readonly insertsTitle: boolean;
  readonly titleText: string | null;
  readonly attrEffects: readonly { readonly ordinal: number; readonly name: string; readonly value: string | null }[];
}

/** The applied patch (structurally satisfied by ops/apply.ts ApplySuccess). */
export interface AppliedPatch {
  readonly text: string;
  readonly deltas: readonly EditDelta[];
  readonly insertedTitleStart: number | null;
}

export interface InvariantResult {
  readonly ok: boolean;
  readonly reasons: readonly InvariantReason[];
  /** The re-parse of the patched copy (null when it failed). */
  readonly after: ParsedPage | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Measurement functions (each used on both sides).

const NON_VISIBLE_TEXT_CONTAINERS: ReadonlySet<string> = new Set(["script", "style", "template", "noscript"]);

/**
 * Text of the document <body>: every text node under it, skipping <script>, <style>, <noscript> and <template>
 * contents; ASCII whitespace runs collapsed to one space, trimmed. <title> lives in <head> and is not included.
 */
export function visibleBodyText(page: ParsedPage): string {
  if (page.bodyEntry === null) return "";
  const body = page.entries[page.bodyEntry]?.node;
  if (body === undefined) return "";
  let out = "";
  const stack = [...body.childNodes].reverse();
  while (stack.length > 0) {
    const n = stack.pop();
    if (n === undefined) continue;
    if (isTextNode(n)) {
      out += n.value;
      continue;
    }
    if (!isElementNode(n)) continue;
    if (NON_VISIBLE_TEXT_CONTAINERS.has(n.tagName)) continue;
    const kids = n.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k !== undefined) stack.push(k);
    }
  }
  return out.replace(/[\t\n\f\r ]+/g, " ").trim();
}

export interface InteractiveItem {
  /** `o<ordinal>` or `u<index among unanchored entries>`. */
  readonly key: string;
  readonly native: Focusability;
  readonly focusable: boolean | "undecidable";
  readonly inTabOrder: boolean | "undecidable";
  readonly role: string | null;
  readonly handlers: readonly string[];
}

/**
 * The interactive inventory (one function, both sides): elements outside template contents that are natively
 * interactive (focusability not `not_focusable`), carry tabindex >= 0, or carry on* handler attributes. The
 * tabindex value itself is not part of an item (the tabindex fix changes it); whether the element is focusable
 * and in the sequential tab order is.
 */
export function interactiveInventory(page: ParsedPage): InteractiveItem[] {
  const items: InteractiveItem[] = [];
  let unanchoredIndex = 0;
  for (let i = 0; i < page.entries.length; i++) {
    const entry = page.entries[i];
    if (entry === undefined) continue;
    const ordinal = page.entryOrdinals[i] ?? null;
    const key = ordinal === null ? `u${unanchoredIndex++}` : `o${ordinal}`;
    if (entry.inTemplate) continue;
    if (ordinal !== null && ordinal === page.insertedTitleOrdinal) continue;
    const native = nativeFocusability(entry);
    const tab = parseHtmlInteger(getAttr(entry, "tabindex"));
    const handlers = entry.node.attrs
      .filter((a) => isHandlerAttrName(a.name))
      .map((a) => a.name.toLowerCase())
      .sort();
    const member = native !== "not_focusable" || (tab !== null && tab >= 0) || handlers.length > 0;
    if (!member) continue;
    const nativeBool: boolean | "undecidable" = native === "focusable" ? true : native === "not_focusable" ? false : "undecidable";
    const role = getAttr(entry, "role");
    items.push({
      key,
      native,
      focusable: tab !== null ? true : nativeBool,
      inTabOrder: tab !== null ? tab >= 0 : nativeBool,
      role: role === null ? null : role.trim().toLowerCase(),
      handlers,
    });
  }
  return items;
}

/** id -> multiplicity over the document (template contents excluded, recovery clones included). */
export function idMultiplicity(page: ParsedPage): ReadonlyMap<string, number> {
  return new Map(Object.entries(page.idCounts));
}

interface ScriptPrint {
  readonly key: string;
  readonly startTag: string | null;
  readonly endTag: string | null;
  readonly text: string;
}

/** Every <script> element (any namespace): its exact start/end tag bytes and its text. */
export function scriptPrints(page: ParsedPage): ScriptPrint[] {
  const out: ScriptPrint[] = [];
  let unanchoredIndex = 0;
  for (let i = 0; i < page.entries.length; i++) {
    const entry = page.entries[i];
    if (entry === undefined) continue;
    const ordinal = page.entryOrdinals[i] ?? null;
    const key = ordinal === null ? `u${unanchoredIndex++}` : `o${ordinal}`;
    if (entry.tagName.toLowerCase() !== "script") continue;
    const rec = ordinal === null ? undefined : page.elements[ordinal];
    out.push({
      key,
      startTag: rec === undefined ? null : page.original.slice(rec.startTag.start, rec.startTag.end),
      endTag: rec === undefined || rec.endTag === null ? null : page.original.slice(rec.endTag.start, rec.endTag.end),
      // Keep raw bytes even in foreign <script>, where character references can decode to the same text.
      text: rec === undefined
        ? textContent(entry.node)
        : page.original.slice(rec.startTag.end, rec.endTag?.start ??
          ((entry.node.sourceCodeLocation?.endOffset ?? page.view.length) + page.bomDelta)),
    });
  }
  return out;
}

interface HandlerPrint {
  readonly key: string;
  /** Decoded `name=value` pairs, attribute order. */
  readonly decoded: readonly string[];
  /** Raw source text of each on* attribute occurrence (duplicates included), or null when the tag did not scan. */
  readonly raw: readonly string[] | null;
}

/** Every element's on* attributes, decoded and (for source-located elements) as raw bytes. */
export function handlerPrints(page: ParsedPage): HandlerPrint[] {
  const out: HandlerPrint[] = [];
  let unanchoredIndex = 0;
  for (let i = 0; i < page.entries.length; i++) {
    const entry = page.entries[i];
    if (entry === undefined) continue;
    const ordinal = page.entryOrdinals[i] ?? null;
    const key = ordinal === null ? `u${unanchoredIndex++}` : `o${ordinal}`;
    if (ordinal !== null && ordinal === page.insertedTitleOrdinal) continue;
    const decoded = entry.node.attrs.filter((a) => isHandlerAttrName(a.name)).map((a) => `${a.name.toLowerCase()}=${a.value}`);
    let raw: string[] | null = null;
    const rec = ordinal === null ? undefined : page.elements[ordinal];
    if (rec !== undefined) {
      const scan = scanStartTag(page.original, rec.startTag);
      raw = scan === null ? null : scan.attrs.filter((a) => isHandlerAttrName(a.name)).map((a) => rawAttrText(page.original, a));
    }
    // Elements without handlers are listed only when their start tag did not scan, so that a change in
    // scannability is still detected.
    const unscannable = rec !== undefined && raw === null;
    if (decoded.length > 0 || (raw !== null && raw.length > 0) || unscannable) out.push({ key, decoded, raw });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The check.

function sameRange(a: SourceRange, b: SourceRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/** Ranges an edit on this ordinal may be resolved to (independently recomputed from the unpatched parse). */
function allowedRegions(before: ParsedPage, ordinal: number): SourceRange[] {
  const rec = before.elements[ordinal];
  if (rec === undefined) return [];
  const out: SourceRange[] = [rec.startTag];
  if (rec.endTag !== null) out.push(rec.endTag);
  if (rec.namespace === HTML_NS && rec.tagName === "title") {
    const t = before.titles.find((x) => x.ordinal === ordinal);
    if (t !== undefined && t.contentRange !== null) out.push(t.contentRange);
  }
  if (before.head !== null && before.head.ordinal === ordinal && before.head.endTag !== null) {
    out.push({ start: before.head.endTag.start, end: before.head.endTag.start });
  }
  return out;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Run every invariant. `before` is the parse of the unpatched source, `patch` what resolve produced, `applied`
 * what apply produced. The re-parse uses `applied.insertedTitleStart` to exclude the inserted title.
 */
export function checkInvariants(before: ParsedPage, patch: PatchDescription, applied: AppliedPatch): InvariantResult {
  const reasons: InvariantReason[] = [];
  const add = (r: InvariantReason): void => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  // 1. Patch provenance.
  if (bomDeltaOf(applied.text) !== before.bomDelta) add("bom_changed");
  if (spliceEdits(before.original, patch.edits) !== applied.text) add("patch_mismatch");
  if (findEditConflicts(patch.edits).length > 0) add("edit_outside_resolved_range");
  const deltas = computeDeltas(patch.edits);
  if (stableJson(deltas) !== stableJson(applied.deltas)) add("patch_mismatch");
  for (const e of patch.edits) {
    const inside = e.start >= e.within.start && e.end <= e.within.end;
    const regionOk = allowedRegions(before, e.ordinal).some((r) => sameRange(r, e.within));
    if (!inside || !regionOk || !editInBounds(e, before.original.length, before.bomDelta)) add("edit_outside_resolved_range");
  }
  const insertedTitles = patch.edits.filter((e) => e.purpose === "title_insert");
  const titleDelta = deltas.find((d) => d.start === insertedTitles[0]?.start);
  const expectedTitleStart = patch.insertsTitle && insertedTitles.length === 1 ? titleDelta?.newStart ?? null : null;
  if (applied.insertedTitleStart !== expectedTitleStart || (patch.insertsTitle && insertedTitles.length !== 1)) add("inserted_title_not_found");

  // 2. Re-parse.
  let after: ParsedPage;
  try {
    after = parsePage(applied.text, { insertedTitleStart: applied.insertedTitleStart });
  } catch {
    add("reparse_failed");
    return { ok: false, reasons, after: null };
  }
  const titleOrdinal = after.insertedTitleOrdinal;
  if (patch.insertsTitle && (titleOrdinal === null || titleOrdinal !== before.elements.length)) add("inserted_title_not_found");

  // 3. Element sequence, count and offsets.
  const n = before.elements.length;
  const retags = [...(patch.retag === null ? [] : [patch.retag]), ...(patch.retags ?? [])];
  if (new Set(retags.map((r) => r.ordinal)).size !== retags.length || retags.some((r) =>
    before.elements[r.ordinal] === undefined || !/^h[1-6]$/.test(r.tagName))) add("retag_target_mismatch");
  const afterCount = after.elements.length - (titleOrdinal === null ? 0 : 1);
  if (afterCount !== n || (!patch.insertsTitle && titleOrdinal !== null)) {
    add("element_count_changed");
  } else {
    for (let i = 0; i < n; i++) {
      const b = before.elements[i];
      const a = after.elements[i];
      if (b === undefined || a === undefined) {
        add("element_count_changed");
        continue;
      }
      const retag = retags.find((r) => r.ordinal === i);
      if (retag !== undefined) {
        if (a.tagName !== retag.tagName || !/^h[1-6]$/.test(b.tagName)) add("retag_target_mismatch");
      } else if (a.tagName !== b.tagName) {
        add("element_sequence_changed");
      }
      if (a.namespace !== b.namespace || a.parentOrdinal !== b.parentOrdinal || a.inTemplate !== b.inTemplate) add("element_sequence_changed");
      if (mapOffset(deltas, b.startTag.start) !== a.startTag.start || mapOffset(deltas, b.startTag.end, "left") !== a.startTag.end) {
        add("element_offset_mismatch");
      }
      if ((b.endTag === null) !== (a.endTag === null) || (b.endTag !== null && a.endTag !== null &&
        (mapOffset(deltas, b.endTag.start) !== a.endTag.start || mapOffset(deltas, b.endTag.end, "left") !== a.endTag.end))) {
        add("element_offset_mismatch");
      }
    }
    if (titleOrdinal !== null) {
      const t = after.elements[titleOrdinal];
      if (t === undefined || t.tagName !== "title" || t.namespace !== HTML_NS || t.parentOrdinal !== (before.head?.ordinal ?? null)) {
        add("inserted_title_not_found");
      }
    }
  }
  const unanchoredPrint = (p: ParsedPage): string =>
    stableJson(p.unanchored.map((u) => [u.tagName, u.namespace, u.reason, u.parentOrdinal, u.inTemplate]));
  if (unanchoredPrint(before) !== unanchoredPrint(after)) add("unanchored_elements_changed");

  // 4. Visible body text.
  if (visibleBodyText(before) !== visibleBodyText(after)) add("visible_text_changed");

  // 5. Interactive inventory.
  if (stableJson(interactiveInventory(before)) !== stableJson(interactiveInventory(after))) add("interactive_inventory_changed");

  // 6. Id multiplicity.
  const idsBefore = idMultiplicity(before);
  const idsAfter = idMultiplicity(after);
  for (const [id, count] of idsAfter) {
    if (count > 1 && (idsBefore.get(id) ?? 0) < count) add("new_duplicate_id");
  }
  if (idsBefore.size !== idsAfter.size || [...idsBefore].some(([id, c]) => idsAfter.get(id) !== c)) add("id_multiplicity_changed");

  // 7. Scripts and handlers byte-identical.
  if (stableJson(scriptPrints(before)) !== stableJson(scriptPrints(after))) add("script_changed");
  if (stableJson(handlerPrints(before)) !== stableJson(handlerPrints(after))) add("handler_attr_changed");

  // 8. Op effects observable.
  for (const eff of patch.attrEffects) {
    const rec = after.elements[eff.ordinal];
    const entry = rec === undefined ? undefined : after.entries[rec.entry];
    const value = entry === undefined ? undefined : getAttr(entry, eff.name);
    if (value === undefined || (eff.value === null ? value !== null : value !== eff.value)) add("op_effect_not_observed");
  }
  if (patch.titleText !== null) {
    const t = after.titles;
    if (t.length !== 1 || t[0]?.text !== patch.titleText) add("title_text_not_observed");
  }

  return { ok: reasons.length === 0, reasons, after };
}
