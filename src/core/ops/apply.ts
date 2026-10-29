// Apply resolved edits by offset splicing into the ORIGINAL text (PLAN.md 2.2, CX explicit): ranges are spliced
// highest offset first, the BOM (if any) is preserved byte-for-byte, and the AST is never serialized. Returns the
// patched text plus where every edit landed (deltas) and the patched offset of an inserted <title>, which the
// re-parse excludes from numbering (ordinal n).
import type { ParsedPage } from "../html/parse.ts";
import { bomDeltaOf } from "../html/parse.ts";
import type { Edit, EditDelta } from "../html/patch.ts";
import { computeDeltas, editInBounds, findEditConflicts, spliceEdits } from "../html/patch.ts";
import type { ResolvedOps } from "./resolve.ts";

export const APPLY_FAILURE_REASONS = ["overlapping_ranges", "edit_out_of_bounds", "edit_touches_bom", "no_edits"] as const;
export type ApplyFailureReason = (typeof APPLY_FAILURE_REASONS)[number];

export interface ApplySuccess {
  readonly ok: true;
  readonly text: string;
  /** The edits, ascending by original start. */
  readonly edits: readonly Edit[];
  readonly deltas: readonly EditDelta[];
  /** Start offset of the inserted <title> in the patched text, else null. */
  readonly insertedTitleStart: number | null;
}

export interface ApplyFailure {
  readonly ok: false;
  readonly reason: ApplyFailureReason;
  /** Index pairs of conflicting edits (input order) for overlapping_ranges. */
  readonly conflicts: readonly (readonly [number, number])[];
}

export type ApplyResult = ApplySuccess | ApplyFailure;

/**
 * Splice edits into `original`. Refuses (never trims) a set with conflicting ranges, out-of-bounds offsets or an
 * edit that would touch a leading BOM. Used for one fix and, in M3, for the combined export.
 */
export function applyEdits(original: string, edits: readonly Edit[]): ApplyResult {
  if (edits.length === 0) return { ok: false, reason: "no_edits", conflicts: [] };
  const bom = bomDeltaOf(original);
  for (const e of edits) {
    if (!editInBounds(e, original.length)) return { ok: false, reason: "edit_out_of_bounds", conflicts: [] };
    if (e.start < bom) return { ok: false, reason: "edit_touches_bom", conflicts: [] };
  }
  const conflicts = findEditConflicts(edits);
  if (conflicts.length > 0) return { ok: false, reason: "overlapping_ranges", conflicts };

  const text = spliceEdits(original, edits);
  const sorted = [...edits].sort((x, y) => x.start - y.start || x.end - y.end);
  const deltas = computeDeltas(sorted);
  let insertedTitleStart: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]?.purpose === "title_insert") insertedTitleStart = deltas[i]?.newStart ?? null;
  }
  return { ok: true, text, edits: sorted, deltas, insertedTitleStart };
}

/** Apply one fix's resolved edits to the page it was resolved against. */
export function applyResolved(page: ParsedPage, resolved: Pick<ResolvedOps, "edits">): ApplyResult {
  return applyEdits(page.original, resolved.edits);
}
