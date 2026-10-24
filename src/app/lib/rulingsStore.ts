import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "../../shared/deps.ts";
import type { Ruling, RulingKey } from "../../core/gate/combine.ts";
import { rulingKeyEquals } from "../../core/gate/combine.ts";
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const KeySchema = z.object({ pageSha256: Hash, rule: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), ordinal: z.number().int().nonnegative().max(999999999), opsSha256: Hash, engineProfile: z.string().min(1).max(200) }).strict();
const ActionSchema = z.enum(["approve", "reject", "skip"]);
const RowSchema = z.object({ id: z.string(), user_id: z.string(), page_sha256: Hash, rule_id: z.string(), ordinal: z.number().int().nonnegative(), ops_sha256: Hash,
  engine_profile: z.string(), decision: ActionSchema, note: z.string().nullable(), seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), created_at: z.string() }).strict();
const COLUMNS = "id,user_id,page_sha256,rule_id,ordinal,ops_sha256,engine_profile,decision,note,seq,created_at";
const HISTORY_PAGE_SIZE = 200;
export const RULING_HISTORY_MAX_PAGES = 100;
export interface RulingsStore {
  /** Append history, never an approval-only projection: canonical latestRulingFor decides exact-key highest seq. */
  list(pageSha256: string): Promise<Ruling[]>;
  append(key: RulingKey, action: Ruling["action"]): Promise<Ruling>;
}
function clone(ruling: Ruling): Ruling { return { ...ruling, key: { ...ruling.key } }; }
export function createMemoryRulingsStore(): RulingsStore {
  const history: Ruling[] = []; let seq = 0;
  return { async list(pageSha256) { Hash.parse(pageSha256); return history.filter((r) => r.key.pageSha256 === pageSha256).map(clone); },
    async append(key, action) { const ruling = { key: KeySchema.parse(key), action: ActionSchema.parse(action), seq: ++seq }; history.push(ruling); return clone(ruling); } };
}
export function createDatabaseRulingsStore(client: SupabaseClient, userId: string): RulingsStore {
  const decode = (value: unknown, page: string): Ruling => {
    const row = RowSchema.parse(value); if (row.user_id !== userId || row.page_sha256 !== page) throw new Error("ruling_identity_mismatch");
    return { key: KeySchema.parse({ pageSha256: row.page_sha256, rule: row.rule_id, ordinal: row.ordinal, opsSha256: row.ops_sha256, engineProfile: row.engine_profile }), action: row.decision, seq: row.seq };
  };
  return { async list(pageSha256) {
    Hash.parse(pageSha256); const history: Ruling[] = []; let afterSeq = -1;
    for (let page = 0; page < RULING_HISTORY_MAX_PAGES; page++) {
      const result = await client.from("rulings").select(COLUMNS).eq("user_id", userId).eq("page_sha256", pageSha256)
        .order("seq", { ascending: true }).gt("seq", afterSeq).limit(HISTORY_PAGE_SIZE);
      if (result.error !== null) throw new Error("rulings_list_failed");
      if (!Array.isArray(result.data) || result.data.length > HISTORY_PAGE_SIZE) throw new Error("rulings_invalid_response");
      // A short page may be the server's own row cap. Only an empty page proves the history is complete.
      if (result.data.length === 0) return history;
      for (const value of result.data) {
        const ruling = decode(value, pageSha256);
        if (ruling.seq <= afterSeq) throw new Error("rulings_history_nonprogress");
        history.push(ruling); afterSeq = ruling.seq;
      }
    }
    throw new Error("rulings_history_incomplete"); // Never return a truncated approval history.
  }, async append(key, action) {
    const safe = KeySchema.parse(key); ActionSchema.parse(action);
    const result = await client.from("rulings").insert({ user_id: userId, page_sha256: safe.pageSha256, rule_id: safe.rule, ordinal: safe.ordinal,
      ops_sha256: safe.opsSha256, engine_profile: safe.engineProfile, decision: action }).select(COLUMNS).single();
    if (result.error !== null) throw new Error("rulings_append_failed");
    const ruling = decode(result.data, safe.pageSha256); if (!rulingKeyEquals(ruling.key, safe) || ruling.action !== action) throw new Error("ruling_identity_mismatch"); return ruling;
  } };
}
