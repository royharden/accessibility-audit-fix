// what_bug_this_catches: Deno copy drift, secret reads leaking into CLI/app, absent auth/budget source gates,
// and accidental migration weakening. Structural source checks are NOT SQL/RLS/concurrency execution evidence.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const root = fileURLToPath(new URL("../../", import.meta.url));
function files(directory: string): string[] { return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []).sort(); }
describe("edge shared closure/parity", () => {
  it("copies every shared source byte-identically except the reviewed Deno deps import", () => {
    const source = join(root, "src/shared"); const edge = join(root, "supabase/functions/propose-fix/shared");
    expect(files(edge).map((path) => relative(edge, path))).toEqual(files(source).map((path) => relative(source, path)));
    for (const path of files(source)) { const name = relative(source, path); if (name === "deps.ts") continue; expect(readFileSync(join(edge, name)).equals(readFileSync(path)), name).toBe(true); }
    expect(readFileSync(join(edge, "deps.ts"), "utf8")).toContain('"npm:zod@');
  });
  it("keeps provider secret reads in the edge and verifies JWT before any service RPC", () => {
    for (const directory of ["src", "scripts"]) for (const path of files(join(root, directory))) expect(readFileSync(path, "utf8"), relative(root, path)).not.toMatch(/(?:process\.env\s*(?:\.\s*|\[\s*["'])|Deno\.env\.get\(\s*["'])(?:ANTHROPIC_API_KEY|OPENAI_COMPATIBLE_API_KEY|OPENAI_COMPATIBLE_BASE_URL|TYPESAFE_API_KEY)/);
    const index = readFileSync(join(root, "supabase/functions/propose-fix/index.ts"), "utf8");
    expect(index.indexOf("auth.auth.getUser")).toBeGreaterThan(-1); expect(index.indexOf("auth.auth.getUser")).toBeLessThan(index.indexOf('service.rpc("'));
    expect(index).toContain('request.method === "OPTIONS"'); expect(index).toContain("16384"); expect(index).toContain("30000");
    expect(index).toContain("readBoundedBodyJson(request, controller.signal, 16384)");
    expect(readFileSync(join(root, "supabase/config.toml"), "utf8")).toContain("verify_jwt = true");
    const operator = readFileSync(join(root, "src/node/operatorSession.ts"), "utf8");
    expect(operator).toContain("persistSession: false"); expect(operator).not.toMatch(/process\.env[^\n]*(?:PASSWORD|PASSWD)/i);
  });
});
it("migration source declares exactly three RLS tables, scoped claims and conservative stored-period settlement", () => {
  const a = readFileSync(join(root, "supabase/migrations/20261024000100_rulings.sql"), "utf8").toLowerCase();
  const b = readFileSync(join(root, "supabase/migrations/20261024000200_llm_calls_budgets.sql"), "utf8").toLowerCase();
  const c = readFileSync(join(root, "supabase/migrations/20261024000300_budget_rpcs.sql"), "utf8").toLowerCase();
  expect((`${a}\n${b}`.match(/create table public\./g) ?? []).length).toBe(3);
  for (const table of ["rulings", "budgets", "llm_calls"]) expect(`${a}\n${b}`).toContain(`alter table public.${table} enable row level security`);
  expect(a).toContain("auth.uid()"); expect(a).toContain("generated always as identity"); expect(b).toMatch(/unique\s*\(user_id,\s*attempt_id\)/);
  for (const scope of ["global", "user", "eval_run"]) expect(b).toContain(`where scope = '${scope}'`);
  expect(b).not.toMatch(/create policy[^;]*on public\.(?:llm_calls|budgets)[^;]*for (?:insert|update|delete)/s);
  for (const rpc of ["llm_budget_settings", "has_eval_budget", "reserve_llm_call", "settle_llm_call"]) {
    expect(c).toContain(`create function public.${rpc}`); expect(c).toMatch(new RegExp(`revoke execute on function public\\.${rpc}[^;]+from public, anon, authenticated`));
    expect(c).toMatch(new RegExp(`grant execute on function public\\.${rpc}[^;]+to service_role`));
  }
  expect(c).toContain("security definer set search_path = public, pg_temp"); expect(c).toContain("request_sha256 <> p_request_sha256"); expect(c).toContain("attempt_conflict");
  expect(c).toContain("on conflict (user_id, attempt_id) do nothing"); expect(c).toContain("clock_timestamp() at time zone 'utc'");
  expect(c).not.toMatch(/insert into public\.budgets[^;]+eval_run/s);
  expect(c).toContain("v_call.budget_period_key"); expect(c).toContain("v_call.status <> 'reserved'"); expect(c).toContain("p_input_tokens is null or p_output_tokens is null");
  expect(c).toContain("v_call.reserved_usd_micros"); expect(c).toContain("prices.input_rate > 0"); expect(c).toContain("pin-at-activation");
});

// what_bug_this_catches: hardcoded reserve caps bypassing the plan's service-only SQL settings function.
it("demo reservation obtains both daily defaults from the service-only settings function", () => {
  const sql = readFileSync(join(root, "supabase/migrations/20261024000300_budget_rpcs.sql"), "utf8").toLowerCase();
  const settings = sql.match(/create function public\.llm_budget_settings\(\)[\s\S]*?\$\$;/)?.[0] ?? "";
  expect(settings).toMatch(/returns table\(global_daily_cap_usd_micros bigint,\s*user_daily_cap_usd_micros bigint\)/);
  expect(settings).toContain("language sql stable security definer set search_path = public, pg_temp");
  expect(settings).toContain("select 2000000::bigint, 250000::bigint;");
  expect(sql).toContain("revoke execute on function public.llm_budget_settings() from public, anon, authenticated;");
  expect(sql).toContain("grant execute on function public.llm_budget_settings() to service_role;");
  const reserve = sql.split("create function public.reserve_llm_call(")[1]?.split("create function public.settle_llm_call(")[0] ?? "";
  expect(reserve).toContain("select * into v_settings from public.llm_budget_settings();");
  expect(reserve).toContain("values('global',null,v_period,v_settings.global_daily_cap_usd_micros)");
  expect(reserve).toContain("values('user',p_user_id,v_period,v_settings.user_daily_cap_usd_micros)");
  expect(reserve).not.toMatch(/\b(?:2000000|250000)\b/);
});

it("keeps the Jev activation policy byte-identical across client and edge", () => {
  expect(readFileSync(join(root, "config/jev-thresholds.json")).equals(readFileSync(join(root, "supabase/functions/propose-fix/jev-thresholds.json")))).toBe(true);
});
