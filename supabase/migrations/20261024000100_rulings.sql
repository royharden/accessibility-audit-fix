-- Source only: never applied during Dirty Mode. Fresh target; inspect history before activation.
create table public.rulings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  page_sha256 text not null check (page_sha256 ~ '^[a-f0-9]{64}$'),
  rule_id text not null check (rule_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  ordinal integer not null check (ordinal between 0 and 999999999),
  ops_sha256 text not null check (ops_sha256 ~ '^[a-f0-9]{64}$'),
  engine_profile text not null check (char_length(engine_profile) between 1 and 200),
  decision text not null check (decision in ('approve','reject','skip')),
  note text check (char_length(note) <= 500),
  seq bigint generated always as identity unique,
  created_at timestamptz not null default now()
);
create index rulings_user_page_idx on public.rulings(user_id, page_sha256);
alter table public.rulings enable row level security;
revoke all on table public.rulings from public, anon, authenticated;
grant select, insert on table public.rulings to authenticated;
grant usage, select on sequence public.rulings_seq_seq to authenticated;
grant all on table public.rulings to service_role;
grant usage, select on sequence public.rulings_seq_seq to service_role;
create policy rulings_select_own on public.rulings for select to authenticated using (user_id = auth.uid());
create policy rulings_insert_own on public.rulings for insert to authenticated with check (user_id = auth.uid());
-- No UPDATE/DELETE privileges or policies: human rulings are append-only. Highest seq wins per exact key.
