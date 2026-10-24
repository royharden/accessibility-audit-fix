// Op -> edit ranges, decided by code, never by the proposer (PLAN.md 2.2-2.3; CL 2.4 R2, 2.5).
//
// Every op carries the finding fingerprint (`rule:ordinal`); resolve looks the ordinal up in the unpatched parse
// and turns the op into splices of the ORIGINAL text:
//   set_attr / mark_decorative  insert or replace one attribute in the target's start tag (mark_decorative: alt=""
//                               on an HTML <img> only);
//   remove_attr tabindex        remove it from the start tag (positive value, natively focusable element only);
//   set_style_color             one merged edit of the start tag's style attribute (other declarations
//                               byte-preserved; 1-2 properties);
//   retag_heading               the start tag's name and the matching explicit end tag's name, else
//                               needs_human: no_end_tag;
//   set_document_title          fill the one existing empty <title> or insert `<title>...</title>` immediately
//                               before an explicit </head> (explicit <head> too); anything else (multiple titles,
//                               implied head/html, title without explicit tags) -> needs_human: implied_element.
// Outcomes: `rejected` (the proposal is wrong for this element: matrix, preconditions), `needs_human` (no
// source anchor for the edit), `abstain` (ambiguous or undecidable: duplicate attributes, focusability unknown,
// unparseable style, overlapping ranges). Approval never overrides any of them.
import type { Op, SetStyleColorOp } from "../../shared/opsSchema.ts";
import { isBlankText } from "../../shared/opsSchema.ts";
import { checkOpsForFinding } from "../../shared/ruleOps.ts";
import { isPageLevelRule } from "../../shared/rules.ts";
import { parseFingerprint } from "../findings/fingerprint.ts";
import type { ElementRecord, ParsedPage, WalkEntry } from "../html/parse.ts";
import { HTML_NS, getAttr, nativeFocusability, parseHtmlInteger } from "../html/parse.ts";
import type { Edit, StartTagScan } from "../html/patch.ts";
import { escapeTitleText, findEditConflicts, removeAttrEdit, scanStartTag, setAttrEdit, styleEdit, uniqueAttrNames } from "../html/patch.ts";

export const RESOLVE_REJECT_REASONS = [
  "rule_not_eligible",
  "no_ops",
  "op_not_allowed_for_rule",
  "too_many_ops_for_rule",
  "op_fingerprint_mismatch",
  "invalid_fingerprint",
  "ordinal_not_found",
  "page_level_target_not_html",
  "target_in_template",
  "not_a_heading",
  "retag_same_level",
  "not_an_img",
  "tabindex_absent",
  "tabindex_not_positive",
  "tabindex_target_natively_focusable",
  "tabindex_target_not_natively_focusable",
  "title_not_empty",
  "title_text_blank",
  "labelledby_id_missing",
  "labelledby_self_reference",
  "value_not_safe_for_style",
  "edit_touches_bom",
] as const;
export type ResolveRejectReason = (typeof RESOLVE_REJECT_REASONS)[number];

export const RESOLVE_NEEDS_HUMAN_REASONS = ["implied_element", "no_source_anchor", "no_end_tag"] as const;
export type ResolveNeedsHumanReason = (typeof RESOLVE_NEEDS_HUMAN_REASONS)[number];

export const RESOLVE_ABSTAIN_REASONS = [
  "focusability_undecidable",
  "duplicate_attribute",
  "attribute_scan_mismatch",
  "start_tag_scan_failed",
  "style_unparseable",
  "duplicate_style_declaration",
  "labelledby_id_duplicated",
  "overlapping_ranges",
] as const;
export type ResolveAbstainReason = (typeof RESOLVE_ABSTAIN_REASONS)[number];

export type ResolveReason = ResolveRejectReason | ResolveNeedsHumanReason | ResolveAbstainReason;
export type ResolveState = "rejected" | "needs_human" | "abstain";

/** An attribute the ops set (value) or remove (null); checked after re-parse and used for gate (d) names. */
export interface AttrEffect {
  readonly ordinal: number;
  readonly name: string;
  readonly value: string | null;
}

export interface ResolvedOps {
  readonly rule: string;
  readonly fingerprint: string;
  readonly ordinal: number;
  readonly ops: readonly Op[];
  readonly edits: readonly Edit[];
  /** retag_heading target and its new tag name. */
  readonly retag: { readonly ordinal: number; readonly tagName: string } | null;
  /** set_document_title inserted a new <title> (re-parse excludes it from numbering: ordinal n). */
  readonly insertsTitle: boolean;
  /** set_document_title text (decoded form expected after re-parse). */
  readonly titleText: string | null;
  readonly attrEffects: readonly AttrEffect[];
}

export type ResolveOutcome =
  | { readonly ok: true; readonly resolved: ResolvedOps }
  | { readonly ok: false; readonly state: ResolveState; readonly reasons: readonly ResolveReason[] };

type Failure = { readonly ok: false; readonly state: ResolveState; readonly reasons: readonly ResolveReason[] };

function fail(state: ResolveState, ...reasons: ResolveReason[]): Failure {
  return { ok: false, state, reasons };
}

const ASCII_WS_ONLY = /^[\t\n\f\r ]*$/;
const HEADING = /^h([1-6])$/;

interface Target {
  readonly page: ParsedPage;
  readonly record: ElementRecord;
  readonly entry: WalkEntry;
}

/** Lazily scanned start tag, cross-checked against parse5's attribute list. */
function scanTarget(t: Target): StartTagScan | Failure {
  const scan = scanStartTag(t.page.original, t.record.startTag);
  if (scan === null) return fail("abstain", "start_tag_scan_failed");
  // The tree builder can merge attributes from a later <html>/<body> tag, and parse5 adjusts foreign names: the
  // element's attributes must be exactly this start tag's (first-occurrence) attributes before we edit it.
  const fromScan = uniqueAttrNames(scan).sort();
  const fromTree = t.record.attrs.map((a) => a.name.toLowerCase()).sort();
  if (fromScan.length !== fromTree.length || fromScan.some((n, i) => n !== fromTree[i])) {
    return fail("abstain", "attribute_scan_mismatch");
  }
  return scan;
}

function isFailure(x: unknown): x is Failure {
  return typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false;
}

interface Built {
  readonly edits: Edit[];
  readonly effects: AttrEffect[];
}

function attrFailure(code: "duplicate_attribute" | "attribute_absent"): Failure {
  return code === "duplicate_attribute" ? fail("abstain", "duplicate_attribute") : fail("rejected", "tabindex_absent");
}

function tabindexPreconditions(t: Target, wantNativelyFocusable: boolean): Failure | null {
  const raw = getAttr(t.entry, "tabindex");
  if (raw === null) return fail("rejected", "tabindex_absent");
  const n = parseHtmlInteger(raw);
  if (n === null || n <= 0) return fail("rejected", "tabindex_not_positive");
  const focus = nativeFocusability(t.entry);
  if (focus === "undecidable") return fail("abstain", "focusability_undecidable");
  if (wantNativelyFocusable && focus !== "focusable") return fail("rejected", "tabindex_target_not_natively_focusable");
  if (!wantNativelyFocusable && focus === "focusable") return fail("rejected", "tabindex_target_natively_focusable");
  return null;
}

function labelledbyPreconditions(t: Target, value: string): Failure | null {
  const ids = value.trim().split(/[\t\n\f\r ]+/).filter((s) => s !== "");
  const own = getAttr(t.entry, "id");
  for (const id of ids) {
    if (own !== null && id === own) return fail("rejected", "labelledby_self_reference");
    const count = Object.hasOwn(t.page.idCounts, id) ? (t.page.idCounts[id] ?? 0) : 0;
    if (count === 0) return fail("rejected", "labelledby_id_missing");
    if (count > 1) return fail("abstain", "labelledby_id_duplicated");
  }
  return null;
}

function resolveElementOps(t: Target, ops: readonly Op[]): Built | Failure {
  const edits: Edit[] = [];
  const effects: AttrEffect[] = [];
  const meta = { ordinal: t.record.ordinal };
  let scan: StartTagScan | null = null;
  const getScan = (): StartTagScan | Failure => {
    if (scan !== null) return scan;
    const s = scanTarget(t);
    if (!isFailure(s)) scan = s;
    return s;
  };

  const styleOps: SetStyleColorOp[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "set_style_color":
        styleOps.push(op);
        break;
      case "set_attr": {
        if (op.name === "tabindex") {
          const pre = tabindexPreconditions(t, false);
          if (pre !== null) return pre;
        } else if (op.name === "aria-labelledby") {
          const pre = labelledbyPreconditions(t, op.value);
          if (pre !== null) return pre;
        }
        const s = getScan();
        if (isFailure(s)) return s;
        const e = setAttrEdit(s, op.name, op.value, meta);
        if (typeof e === "string") return attrFailure(e);
        edits.push(e);
        effects.push({ ordinal: t.record.ordinal, name: op.name, value: op.value });
        break;
      }
      case "remove_attr": {
        const pre = tabindexPreconditions(t, true);
        if (pre !== null) return pre;
        const s = getScan();
        if (isFailure(s)) return s;
        const e = removeAttrEdit(t.page.original, s, op.name, meta);
        if (typeof e === "string") return attrFailure(e);
        edits.push(e);
        effects.push({ ordinal: t.record.ordinal, name: op.name, value: null });
        break;
      }
      case "mark_decorative": {
        if (t.record.namespace !== HTML_NS || t.record.tagName !== "img") return fail("rejected", "not_an_img");
        const s = getScan();
        if (isFailure(s)) return s;
        const e = setAttrEdit(s, "alt", "", meta);
        if (typeof e === "string") return attrFailure(e);
        edits.push(e);
        effects.push({ ordinal: t.record.ordinal, name: "alt", value: "" });
        break;
      }
      case "retag_heading":
      case "set_document_title":
        // Handled by their own resolvers; never mixed with element ops (matrix maxOps is 1 for those rules).
        return fail("rejected", "op_not_allowed_for_rule");
    }
  }
  if (styleOps.length > 0) {
    const s = getScan();
    if (isFailure(s)) return s;
    const e = styleEdit(
      t.page.original,
      s,
      styleOps.map((o) => ({ property: o.property, value: o.value })),
      meta,
    );
    if (typeof e === "string") {
      if (e === "value_not_safe_for_style") return fail("rejected", "value_not_safe_for_style");
      return fail("abstain", e);
    }
    edits.push(e);
  }
  return { edits, effects };
}

function resolveRetag(t: Target, level: number): { edits: Edit[]; tagName: string } | Failure {
  const m = t.record.namespace === HTML_NS ? HEADING.exec(t.record.tagName) : null;
  if (m === null) return fail("rejected", "not_a_heading");
  if (Number(m[1]) === level) return fail("rejected", "retag_same_level");
  const endTag = t.record.endTag;
  if (endTag === null) return fail("needs_human", "no_end_tag");
  const src = t.page.original;
  const st = t.record.startTag;
  if (src.slice(st.start + 1, st.start + 3).toLowerCase() !== t.record.tagName) return fail("abstain", "start_tag_scan_failed");
  if (src.slice(endTag.start + 2, endTag.start + 4).toLowerCase() !== t.record.tagName) return fail("needs_human", "no_end_tag");
  const tagName = `h${level}`;
  return {
    tagName,
    edits: [
      { start: st.start + 1, end: st.start + 3, text: tagName, ordinal: t.record.ordinal, within: st, purpose: "retag_start" },
      { start: endTag.start + 2, end: endTag.start + 4, text: tagName, ordinal: t.record.ordinal, within: endTag, purpose: "retag_end" },
    ],
  };
}

function resolveTitle(page: ParsedPage, text: string): { edit: Edit; inserts: boolean } | Failure {
  if (isBlankText(text)) return fail("rejected", "title_text_blank");
  const head = page.head;
  if (head === null || head.ordinal === null || head.endTag === null) return fail("needs_human", "implied_element");
  const escaped = escapeTitleText(text);
  if (page.titles.length > 1) return fail("needs_human", "implied_element");
  const only = page.titles[0];
  if (only !== undefined) {
    if (only.ordinal === null || only.contentRange === null || page.entries[only.entry]?.parentIndex !== head.entry) {
      return fail("needs_human", "implied_element");
    }
    if (!ASCII_WS_ONLY.test(only.text)) return fail("rejected", "title_not_empty");
    const r = only.contentRange;
    return { inserts: false, edit: { start: r.start, end: r.end, text: escaped, ordinal: only.ordinal, within: r, purpose: "title_fill" } };
  }
  const at = head.endTag.start;
  return {
    inserts: true,
    edit: { start: at, end: at, text: `<title>${escaped}</title>`, ordinal: head.ordinal, within: { start: at, end: at }, purpose: "title_insert" },
  };
}

/**
 * Resolve a proposal's ops for one finding into edits of page.original. `page` must be the parse of the
 * unpatched source (not a re-parse with an inserted title).
 */
export function resolveOps(page: ParsedPage, finding: { readonly rule: string; readonly fingerprint: string }, ops: readonly Op[]): ResolveOutcome {
  const matrix = checkOpsForFinding(finding, ops);
  if (!matrix.ok) return fail("rejected", ...matrix.reasons);
  const parts = parseFingerprint(finding.fingerprint);
  if (parts === null) return fail("rejected", "invalid_fingerprint");

  if (isPageLevelRule(finding.rule)) {
    if (page.htmlOrdinal === null) return fail("needs_human", page.htmlReason ?? "implied_element");
    if (parts.ordinal !== page.htmlOrdinal) return fail("rejected", "page_level_target_not_html");
  }
  const record = page.elements[parts.ordinal];
  if (record === undefined || page.insertedTitleOrdinal === parts.ordinal) return fail("rejected", "ordinal_not_found");
  const entry = page.entries[record.entry];
  if (entry === undefined) return fail("rejected", "ordinal_not_found");
  if (record.inTemplate) return fail("rejected", "target_in_template");
  const target: Target = { page, record, entry };

  let edits: Edit[] = [];
  let effects: AttrEffect[] = [];
  let retag: ResolvedOps["retag"] = null;
  let insertsTitle = false;
  let titleText: string | null = null;

  const first = ops[0];
  if (first !== undefined && first.op === "retag_heading") {
    const r = resolveRetag(target, first.level);
    if (isFailure(r)) return r;
    edits = r.edits;
    retag = { ordinal: record.ordinal, tagName: r.tagName };
  } else if (first !== undefined && first.op === "set_document_title") {
    const r = resolveTitle(page, first.text);
    if (isFailure(r)) return r;
    edits = [r.edit];
    insertsTitle = r.inserts;
    titleText = first.text;
  } else {
    const r = resolveElementOps(target, ops);
    if (isFailure(r)) return r;
    edits = r.edits;
    effects = r.effects;
  }

  if (edits.some((e) => e.start < page.bomDelta)) return fail("rejected", "edit_touches_bom");
  if (findEditConflicts(edits).length > 0) return fail("abstain", "overlapping_ranges");

  return {
    ok: true,
    resolved: {
      rule: finding.rule,
      fingerprint: finding.fingerprint,
      ordinal: record.ordinal,
      ops: [...ops],
      edits,
      retag,
      insertsTitle,
      titleText,
      attrEffects: effects,
    },
  };
}
