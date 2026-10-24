// Combined export is all-or-blocked. Exact-key human approval cannot override a strict code rejection.
import type { AuditEngine, AuditResult } from "../audit/types.ts";
import type { ParsedPage } from "../html/parse.ts";
import type { InvariantResult, PatchDescription } from "../html/invariants.ts";
import { checkInvariants } from "../html/invariants.ts";
import { findEditConflicts } from "../html/patch.ts";
import { applyEdits } from "../ops/apply.ts";
import type { ResolvedOps } from "../ops/resolve.ts";
import { resolveOps } from "../ops/resolve.ts";
import { formatFingerprint } from "../findings/fingerprint.ts";
import type { GateResult } from "./reasons.ts";
import { changedNameOrdinals, strictGate } from "./strict.ts";

export interface RulingKey {
  readonly pageSha256: string;
  readonly rule: string;
  readonly ordinal: number;
  readonly opsSha256: string;
  readonly engineProfile: string;
}
export interface Ruling { readonly key: RulingKey; readonly action: "approve" | "reject" | "skip"; readonly seq: number }
export function rulingKeyEquals(a: RulingKey, b: RulingKey): boolean {
  return a.pageSha256 === b.pageSha256 && a.rule === b.rule && a.ordinal === b.ordinal &&
    a.opsSha256 === b.opsSha256 && a.engineProfile === b.engineProfile;
}
/** Duplicate highest sequences are ambiguous and confer no approval. */
export function latestRulingFor(key: RulingKey, rulings: readonly Ruling[]): Ruling | null {
  const matches = rulings.filter((r) => rulingKeyEquals(key, r.key) && Number.isSafeInteger(r.seq) && r.seq >= 0);
  const latest = matches.reduce((max, r) => Math.max(max, r.seq), -1);
  const atLatest = matches.filter((r) => r.seq === latest);
  return atLatest.length === 1 ? atLatest[0] ?? null : null;
}
export interface CombineFix { readonly id: string; readonly key: RulingKey; readonly resolved: ResolvedOps; readonly gate: GateResult }
export interface CombineInput {
  readonly page: ParsedPage;
  readonly baseline: AuditResult;
  readonly engine: AuditEngine;
  readonly fixes: readonly CombineFix[];
  readonly rulings: readonly Ruling[];
  /** Code-owned SHA-256 implementation; never supplied by the model. Ops hash is SHA256(JSON.stringify(ops)). */
  readonly sha256: (text: string) => Promise<string>;
  /** Same engine render profile used for baseline and single-fix audits, including iframe stripping if used. */
  readonly render: (source: string, insertedTitleStart: number | null) => string;
  readonly maxDiagnosticAudits?: number;
}
export interface CombineDiagnostic {
  readonly kind: "interaction" | "failing_subset" | "inconclusive" | "budget_exhausted";
  readonly ids: readonly string[];
  readonly reasons: readonly string[];
}
interface SubsetCheck {
  readonly ok: boolean;
  readonly inconclusive: boolean;
  readonly reasons: readonly string[];
  readonly text: string | null;
  readonly after: AuditResult | null;
  readonly invariants: InvariantResult | null;
  readonly gates: readonly GateResult[];
}
export type CombineResult =
  | { readonly state: "ready"; readonly text: string; readonly after: AuditResult; readonly invariants: InvariantResult;
      readonly includedIds: readonly string[]; readonly gates: readonly GateResult[] }
  | { readonly state: "blocked"; readonly reasons: readonly string[]; readonly conflicts: readonly (readonly [string, string])[];
      readonly diagnostics: readonly CombineDiagnostic[]; readonly after: AuditResult | null };

function description(fixes: readonly CombineFix[]): PatchDescription {
  const patches = fixes.map((f) => f.resolved);
  return { edits: patches.flatMap((p) => p.edits), retag: null,
    retags: patches.flatMap((p) => p.retag === null ? [] : [p.retag]),
    insertsTitle: patches.some((p) => p.insertsTitle), titleText: patches.find((p) => p.titleText !== null)?.titleText ?? null,
    attrEffects: patches.flatMap((p) => p.attrEffects) };
}
async function checkSubset(input: CombineInput, fixes: readonly CombineFix[]): Promise<SubsetCheck> {
  const patch = description(fixes);
  const applied = applyEdits(input.page.original, patch.edits);
  if (!applied.ok) return { ok: false, inconclusive: false, reasons: [applied.reason], text: null, after: null, invariants: null, gates: [] };
  const invariants = checkInvariants(input.page, patch, applied);
  let after: AuditResult;
  try { after = await input.engine.audit(input.render(applied.text, applied.insertedTitleStart)); }
  catch { return { ok: false, inconclusive: true, reasons: ["combined_audit_error"], text: null, after: null, invariants, gates: [] }; }
  const names = changedNameOrdinals(fixes.map((f) => f.resolved));
  const gates = fixes.map((f) => strictGate({ baseline: input.baseline, after, invariants, changedNames: names,
    target: { rule: f.resolved.rule, ordinal: f.resolved.ordinal,
      fingerprint: formatFingerprint(f.resolved.rule, f.resolved.ordinal), unmappedReason: null } }));
  return { ok: gates.every((g) => g.accepted === true), inconclusive: gates.some((g) => g.state === "inconclusive"),
    reasons: [...new Set(gates.flatMap((g) => g.reasons))], text: applied.text, after, invariants, gates };
}

/** Diagnostic bisection only. Never exports successful halves or claims a minimal conflict without measuring it. */
async function diagnose(input: CombineInput, fixes: readonly CombineFix[], full: SubsetCheck): Promise<CombineDiagnostic[]> {
  const diagnostics: CombineDiagnostic[] = [];
  let remaining = Math.max(0, Math.min(100, Math.floor(input.maxDiagnosticAudits ?? Math.min(16, fixes.length * 2))));
  const split = async (group: readonly CombineFix[], failed: SubsetCheck): Promise<void> => {
    const ids = group.map((f) => f.id);
    if (failed.inconclusive) { diagnostics.push({ kind: "inconclusive", ids, reasons: failed.reasons }); return; }
    if (group.length === 1) { diagnostics.push({ kind: "failing_subset", ids, reasons: failed.reasons }); return; }
    if (remaining < 2) { diagnostics.push({ kind: "budget_exhausted", ids, reasons: failed.reasons }); return; }
    const midpoint = Math.floor(group.length / 2);
    const left = group.slice(0, midpoint);
    const right = group.slice(midpoint);
    remaining -= 2;
    const a = await checkSubset(input, left);
    const b = await checkSubset(input, right);
    if (a.ok && b.ok) diagnostics.push({ kind: "interaction", ids, reasons: failed.reasons });
    else {
      if (!a.ok) await split(left, a);
      if (!b.ok) await split(right, b);
    }
  };
  await split(fixes, full);
  return diagnostics;
}

export async function combineFixes(input: CombineInput): Promise<CombineResult> {
  const blocked = (reasons: readonly string[], conflicts: readonly (readonly [string, string])[] = []): CombineResult =>
    ({ state: "blocked", reasons, conflicts, diagnostics: [], after: null });
  if (input.fixes.length === 0) return blocked(["no_approved_fixes"]);
  if (input.engine.id !== input.baseline.engine) return blocked(["engine_mismatch"]);
  if (new Set(input.fixes.map((f) => f.id)).size !== input.fixes.length) return blocked(["duplicate_fix_id"]);
  let pageHash: string;
  try { pageHash = await input.sha256(input.page.original); } catch { return blocked(["hash_error"]); }
  const fixes: CombineFix[] = [];
  for (const fix of input.fixes) {
    const { key, resolved } = fix;
    if (fix.gate.gate !== "strict" || fix.gate.accepted !== true || (fix.gate.state !== "verified" && fix.gate.state !== "checked")) {
      return blocked([`fix_not_accepted:${fix.id}`]);
    }
    let opsHash: string;
    try { opsHash = await input.sha256(JSON.stringify(resolved.ops)); } catch { return blocked(["hash_error"]); }
    if (key.pageSha256 !== pageHash || key.opsSha256 !== opsHash || key.engineProfile !== input.baseline.profile ||
      key.rule !== resolved.rule || key.ordinal !== resolved.ordinal) return blocked([`stale_fix_key:${fix.id}`]);
    if (latestRulingFor(key, input.rulings)?.action !== "approve") return blocked([`exact_approval_required:${fix.id}`]);
    const reResolved = resolveOps(input.page, { rule: key.rule, fingerprint: resolved.fingerprint }, resolved.ops);
    if (!reResolved.ok || reResolved.resolved.ordinal !== key.ordinal) return blocked([`resolve_failed:${fix.id}`]);
    fixes.push({ ...fix, resolved: reResolved.resolved });
  }
  const conflicts: [string, string][] = [];
  for (let i = 0; i < fixes.length; i++) for (let j = i + 1; j < fixes.length; j++) {
    const a = fixes[i]; const b = fixes[j];
    if (a === undefined || b === undefined) continue;
    // Conservative: separate fixes sharing a resolved tag/range conflict even if their tiny splices differ.
    if (a.resolved.edits.some((x) => b.resolved.edits.some((y) => findEditConflicts([x.within, y.within]).length > 0 ||
      findEditConflicts([x, y]).length > 0))) conflicts.push([a.id, b.id]);
  }
  if (conflicts.length > 0) return blocked(["overlapping_ranges"], conflicts);
  const full = await checkSubset(input, fixes);
  if (full.ok && full.text !== null && full.after !== null && full.invariants !== null) {
    return { state: "ready", text: full.text, after: full.after, invariants: full.invariants,
      includedIds: fixes.map((f) => f.id), gates: full.gates };
  }
  return { state: "blocked", reasons: full.reasons, conflicts: [], diagnostics: await diagnose(input, fixes, full), after: full.after };
}
