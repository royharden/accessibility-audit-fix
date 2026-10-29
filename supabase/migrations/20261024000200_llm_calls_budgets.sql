-- Source only: three tables total across migrations, no browser budget/call writes.
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global','user','eval_run')),
  user_id uuid references auth.users(id) on delete cascade,
  period_key text not null check (char_length(period_key) between 1 and 200),
  cap_usd_micros bigint not null check (cap_usd_micros >= 0),
  used_usd_micros bigint not null default 0 check (used_usd_micros >= 0),
  reserved_usd_micros bigint not null default 0 check (reserved_usd_micros >= 0),
  check ((scope = 'global') = (user_id is null))
);
create unique index budgets_global_period_unique on public.budgets(period_key) where scope = 'global';
create unique index budgets_user_period_unique on public.budgets(user_id, period_key) where scope = 'user';
create unique index budgets_eval_run_unique on public.budgets(user_id, period_key) where scope = 'eval_run';
alter table public.budgets enable row level security;
revoke all on table public.budgets from public, anon, authenticated;
grant select on table public.budgets to authenticated;
grant all on table public.budgets to service_role;
create policy budgets_select_own_user on public.budgets for select to authenticated
  using (scope = 'user' and user_id = auth.uid());

create table public.llm_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  attempt_id uuid not null,
  provider text not null check (provider in ('anthropic','openai-compatible','typesafe')),
  model text not null check (char_length(model) between 1 and 200),
  proposer text not null check (char_length(proposer) between 1 and 100),
  rule_id text not null check (rule_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  context_sha256 text not null check (context_sha256 ~ '^[a-f0-9]{64}$'),
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  budget_scope text not null check (budget_scope in ('demo','eval_run')),
  budget_period_key text not null check (char_length(budget_period_key) between 1 and 200),
  status text not null check (status in ('reserved','ok','abstain','schema_reject','screened','error','timeout','unknown_charge')),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  reserved_usd_micros bigint not null check (reserved_usd_micros >= 0),
  cost_usd_micros bigint check (cost_usd_micros >= 0 and cost_usd_micros <= reserved_usd_micros),
  latency_ms integer check (latency_ms >= 0),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  unique (user_id, attempt_id)
);
alter table public.llm_calls enable row level security;
revoke all on table public.llm_calls from public, anon, authenticated;
grant select on table public.llm_calls to authenticated;
grant all on table public.llm_calls to service_role;
create policy llm_calls_select_own on public.llm_calls for select to authenticated using (user_id = auth.uid());
-- No browser mutation policies on budgets or llm_calls. Global/eval budget rows are invisible to users.
