// what_bug_this_catches: partial-key approvals, timestamp/latest ordering mistakes, skip/reject as approval,
// or configured database failures silently falling back to memory. SDK is mocked; no database/auth calls.
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDatabaseRulingsStore, createMemoryRulingsStore, RULING_HISTORY_MAX_PAGES } from "../../src/app/lib/rulingsStore.ts";
import { beginDecision, emptyDecisionState, pendingDecision, reconcileDecisions, resetDecisionPage, rulingsForExport, selectDecisionPage } from "../../src/app/lib/decisionState.ts";
import { latestRulingFor } from "../../src/core/gate/combine.ts";
import type { Ruling, RulingKey } from "../../src/core/gate/combine.ts";
const key: RulingKey = { pageSha256: "a".repeat(64), rule: "image-alt", ordinal: 4, opsSha256: "b".repeat(64), engineProfile: "iframe-unit" };
type DatabaseReply = { error: { message: string } | null; data: unknown };
interface MockQuery {
  select(): MockQuery; insert(): MockQuery; eq(column: string, value: unknown): MockQuery;
  order(column: string, options: { ascending: boolean }): MockQuery; gt(column: string, value: number): MockQuery;
  limit(value: number): MockQuery; single(): Promise<DatabaseReply>;
  then(resolve: (value: DatabaseReply) => unknown, reject: (reason: unknown) => unknown): Promise<unknown>;
}
function databaseMock(reply: (afterSeq: number, requested: number) => DatabaseReply): SupabaseClient {
  return { from(table: string) {
    expect(table).toBe("rulings"); const filters = new Map<string, unknown>(); let afterSeq = -1; let requested = 0;
    const query: MockQuery = { select: () => query, insert: () => query,
      eq(column: string, value: unknown) { filters.set(column, value); return query; },
      order(column: string, options: { ascending: boolean }) { expect(column).toBe("seq"); expect(options.ascending).toBe(true); return query; },
      gt(column: string, value: number) { expect(column).toBe("seq"); afterSeq = value; return query; },
      limit(value: number) { requested = value; return query; },
      async single() { return reply(afterSeq, requested); },
      then(resolve: (value: DatabaseReply) => unknown, reject: (reason: unknown) => unknown) {
        expect(filters.get("user_id")).toBe("user-a"); expect(filters.get("page_sha256")).toBe(key.pageSha256);
        return Promise.resolve(reply(afterSeq, requested)).then(resolve, reject);
      },
    }; return query;
  } } as unknown as SupabaseClient; // SDK boundary mock only; no auth/database access.
}
function databaseRow(seq: number, action: Ruling["action"], userId = "user-a") {
  return { id: `row-${seq}`, user_id: userId, page_sha256: key.pageSha256, rule_id: key.rule, ordinal: key.ordinal,
    ops_sha256: key.opsSha256, engine_profile: key.engineProfile, decision: action, note: null, seq, created_at: "same-time" };
}
describe("ruling replay", () => {
  it("requires all five fields and highest numeric seq across approve/reject/skip", async () => {
    const store = createMemoryRulingsStore(); await store.append(key, "approve");
    for (const change of [{ pageSha256: "c".repeat(64) }, { rule: "button-name" }, { ordinal: 5 }, { opsSha256: "c".repeat(64) }, { engineProfile: "other" }]) {
      const changed = { ...key, ...change }; expect(latestRulingFor(changed, await store.list(changed.pageSha256))).toBeNull();
    }
    await store.append(key, "reject"); expect(latestRulingFor(key, await store.list(key.pageSha256))?.action).toBe("reject");
    await store.append(key, "skip"); expect(latestRulingFor(key, await store.list(key.pageSha256))?.action).toBe("skip");
    const approved = await store.append(key, "approve"); expect(approved.seq).toBe(4); expect(latestRulingFor(key, (await store.list(key.pageSha256)).reverse())?.seq).toBe(4);
  });
  it("surfaces configured database errors and identity mismatch instead of recording memory approval", async () => {
    const client = databaseMock(() => ({ error: { message: "denied" }, data: null }));
    const store = createDatabaseRulingsStore(client, "user-a");
    await expect(store.list(key.pageSha256)).rejects.toThrow("rulings_list_failed"); await expect(store.append(key, "approve")).rejects.toThrow("rulings_append_failed");
    const wrong = databaseMock(() => ({ error: null, data: [databaseRow(99, "approve", "user-b")] }));
    await expect(createDatabaseRulingsStore(wrong, "user-a").list(key.pageSha256)).rejects.toThrow("ruling_identity_mismatch");
  });
});

describe("uncertain decision writes", () => {
  // what_bug_this_catches: a committed reject/skip whose response was lost left a cached approval exportable;
  // even a successful stale read must not clear the unresolved exact-key intent.
  it.each(["reject", "skip"] as const)("blocks cached approval after a committed %s loses its response until reconciliation", async (action) => {
    const store = createMemoryRulingsStore(); const approved = await store.append(key, "approve");
    let state = reconcileDecisions(selectDecisionPage(emptyDecisionState(), key.pageSha256), [approved]);
    expect(latestRulingFor(key, rulingsForExport(state))?.action).toBe("approve");
    state = beginDecision(state, key, action);
    const lostResponse = async () => { await store.append(key, action); throw new Error("response_lost_after_commit"); };
    await expect(lostResponse()).rejects.toThrow("response_lost_after_commit");
    expect(() => rulingsForExport(state)).toThrow("rulings_reconciliation_required");
    state = reconcileDecisions(state, [approved]);
    expect(state.trusted).toBe(false); expect(pendingDecision(state)?.action).toBe(action);
    expect(() => rulingsForExport(state)).toThrow("rulings_reconciliation_required");
    const unrelated = { ...approved, key: { ...key, opsSha256: "c".repeat(64) }, action, seq: 99 };
    state = reconcileDecisions(state, [approved, unrelated]);
    expect(state.trusted).toBe(false); // All five key fields still bind the pending intent.
    state = reconcileDecisions(state, await store.list(key.pageSha256));
    expect(state.trusted).toBe(true); expect(pendingDecision(state)).toBeNull();
    expect(latestRulingFor(key, rulingsForExport(state))?.action).toBe(action);
  });
  it("keeps an unresolved intent across audit resets and allows retry without another audit", async () => {
    const store = createMemoryRulingsStore(); const approved = await store.append(key, "approve");
    let state = beginDecision(reconcileDecisions(selectDecisionPage(emptyDecisionState(), key.pageSha256), [approved]), key, "reject");
    state = reconcileDecisions(selectDecisionPage(resetDecisionPage(state), key.pageSha256), [approved]);
    expect(() => rulingsForExport(state)).toThrow("rulings_reconciliation_required");
    const intent = pendingDecision(state); if (intent === null) throw new Error("missing_pending_intent");
    state = beginDecision(state, intent.key, intent.action);
    await store.append(intent.key, intent.action);
    state = reconcileDecisions(state, await store.list(key.pageSha256));
    expect(latestRulingFor(key, rulingsForExport(state))?.action).toBe("reject");
    expect(emptyDecisionState().pending).toEqual([]); // App uses this fresh state on identity changes only.
  });
});

describe("complete database ruling history", () => {
  // what_bug_this_catches: the server's smaller row cap looked like the end of an ascending history,
  // excluding a newer reject/skip and reviving an older approval.
  for (const serverCap of [1, 2]) it.each(["reject", "skip"] as const)(`loads latest %s after older approvals with server cap ${serverCap}`, async (action) => {
    const rows = [databaseRow(1, "approve"), databaseRow(2, "approve"), databaseRow(3, action)];
    const cursors: number[] = [];
    const client = databaseMock((after, requested) => {
      cursors.push(after); expect(requested).toBeGreaterThan(serverCap);
      return { error: null, data: rows.filter((row) => row.seq > after).slice(0, serverCap) };
    });
    const history = await createDatabaseRulingsStore(client, "user-a").list(key.pageSha256);
    expect(history.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(latestRulingFor(key, history)?.action).toBe(action);
    expect(cursors.at(-1)).toBe(3); // An additional empty page, not a short nonempty page, ends the read.
    expect(cursors.length).toBe(serverCap === 1 ? 4 : 3);
  });
  it("rejects nonprogress instead of returning a partial approval history", async () => {
    const client = databaseMock(() => ({ error: null, data: [databaseRow(1, "approve")] }));
    await expect(createDatabaseRulingsStore(client, "user-a").list(key.pageSha256)).rejects.toThrow("rulings_history_nonprogress");
  });
  it("fails closed when the bounded page budget cannot prove completion", async () => {
    let pages = 0;
    const client = databaseMock((after) => { pages++; return { error: null, data: [databaseRow(after + 2, "approve")] }; });
    await expect(createDatabaseRulingsStore(client, "user-a").list(key.pageSha256)).rejects.toThrow("rulings_history_incomplete");
    expect(pages).toBe(RULING_HISTORY_MAX_PAGES);
  });
});
