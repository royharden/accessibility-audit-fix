// Pure ruling trust state. An unknown write keeps its exact-key intent until authoritative history confirms it.
import type { Ruling, RulingKey } from "../../core/gate/combine.ts";
import { latestRulingFor, rulingKeyEquals } from "../../core/gate/combine.ts";
export interface DecisionIntent { readonly key: RulingKey; readonly action: Ruling["action"]; readonly afterSeq: number }
export interface DecisionState {
  readonly pageSha256: string | null;
  readonly rulings: readonly Ruling[];
  readonly trusted: boolean;
  readonly pending: readonly DecisionIntent[];
}
export function emptyDecisionState(): DecisionState { return { pageSha256: null, rulings: [], trusted: false, pending: [] }; }
/** Preserve unresolved intents across input/audit changes; only an identity change discards this state. */
export function resetDecisionPage(state: DecisionState): DecisionState { return { ...state, pageSha256: null, rulings: [], trusted: false }; }
export function selectDecisionPage(state: DecisionState, pageSha256: string): DecisionState {
  return { ...state, pageSha256, rulings: [], trusted: false };
}
export function pendingDecision(state: DecisionState): DecisionIntent | null {
  return state.pending.find((intent) => intent.key.pageSha256 === state.pageSha256) ?? null;
}
export function beginDecision(state: DecisionState, key: RulingKey, action: Ruling["action"]): DecisionState {
  if (key.pageSha256 !== state.pageSha256) throw new Error("rulings_page_mismatch");
  const afterSeq = state.rulings.reduce((max, ruling) => rulingKeyEquals(key, ruling.key) ? Math.max(max, ruling.seq) : max, -1);
  const intent: DecisionIntent = { key: { ...key }, action, afterSeq };
  return { ...state, trusted: false, pending: [...state.pending.filter((prior) => !rulingKeyEquals(prior.key, key)), intent] };
}
/** Call only after a complete authoritative list. An old approval cannot resolve a pending reject/skip. */
export function reconcileDecisions(state: DecisionState, history: readonly Ruling[]): DecisionState {
  if (state.pageSha256 === null || history.some((ruling) => ruling.key.pageSha256 !== state.pageSha256)) throw new Error("rulings_page_mismatch");
  const pending = state.pending.filter((intent) => {
    if (intent.key.pageSha256 !== state.pageSha256) return true;
    const latest = latestRulingFor(intent.key, history);
    return latest === null || latest.seq <= intent.afterSeq || latest.action !== intent.action;
  });
  return { ...state, rulings: history.map((ruling) => ({ ...ruling, key: { ...ruling.key } })), pending,
    trusted: !pending.some((intent) => intent.key.pageSha256 === state.pageSha256) };
}
/** Shared guard for preparing exports and downloading previously prepared output. */
export function rulingsForExport(state: DecisionState): readonly Ruling[] {
  if (!state.trusted || state.pageSha256 === null || pendingDecision(state) !== null) throw new Error("rulings_reconciliation_required");
  return state.rulings;
}
