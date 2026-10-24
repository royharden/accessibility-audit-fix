-- Source only; none of these functions has executed. Prices/models must be pinned at activation.
-- All money is integer USD micro-units. No caller supplies a cap, price or reservation amount.
create function public.llm_price(p_provider text, p_model text)
returns table(input_usd_micros_per_million bigint, output_usd_micros_per_million bigint, max_input_tokens integer, max_output_tokens integer)
language sql stable security definer set search_path = public, pg_temp as $$
  -- Replace NULL rates AND placeholder model ids with verified pins before any live use.
  -- jev-1.13.0 is the comparison pin; its price is still unconfigured. Zero output pricing may be valid.
  select prices.input_rate, prices.output_rate, 32768, 1024
  from (values
    ('anthropic'::text, 'MODEL-A-PIN-AT-ACTIVATION'::text, null::bigint, null::bigint),
    ('openai-compatible'::text, 'MODEL-B-PIN-AT-ACTIVATION'::text, null::bigint, null::bigint),
    ('typesafe'::text, 'jev-1.13.0'::text, null::bigint, null::bigint)
  ) as prices(provider, model, input_rate, output_rate)
  where prices.provider = p_provider and prices.model = p_model
    and prices.model not like '%PIN-AT-ACTIVATION%'
    and prices.input_rate > 0 and prices.output_rate >= 0;
$$;
revoke execute on function public.llm_price(text,text) from public, anon, authenticated;
grant execute on function public.llm_price(text,text) to service_role;

create function public.llm_budget_settings()
returns table(global_daily_cap_usd_micros bigint, user_daily_cap_usd_micros bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  -- Server-owned default caps; callers cannot supply or change either daily cap.
  select 2000000::bigint, 250000::bigint;
$$;
revoke execute on function public.llm_budget_settings() from public, anon, authenticated;
grant execute on function public.llm_budget_settings() to service_role;

create function public.has_eval_budget(p_user_id uuid, p_run_key text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.budgets where scope = 'eval_run' and user_id = p_user_id and period_key = p_run_key);
$$;
revoke execute on function public.has_eval_budget(uuid,text) from public, anon, authenticated;
grant execute on function public.has_eval_budget(uuid,text) to service_role;

create function public.reserve_llm_call(
  p_user_id uuid, p_scope text, p_run_key text, p_attempt_id uuid,
  p_provider text, p_model text, p_proposer text, p_rule_id text, p_context_sha256 text, p_request_sha256 text
) returns table(call_id uuid, claim text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_call public.llm_calls%rowtype;
  v_id uuid;
  v_period text;
  v_price record;
  v_settings record;
  v_amount bigint;
  v_global public.budgets%rowtype;
  v_user public.budgets%rowtype;
  v_eval public.budgets%rowtype;
begin
  if p_user_id is null or p_attempt_id is null or p_scope is null
    or p_scope not in ('demo','eval_run')
    or (p_scope = 'demo' and p_run_key is not null)
    or (p_scope = 'eval_run' and (p_run_key is null or char_length(p_run_key) not between 1 and 200)) then
    raise exception 'bad_request';
  end if;
  if p_context_sha256 is null or p_context_sha256 !~ '^[a-f0-9]{64}$'
    or p_request_sha256 is null or p_request_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'bad_request'; end if;
  v_period := case when p_scope = 'demo' then to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD') else p_run_key end;
  -- Idempotent read permits recovery of an existing call even if pricing was later disabled.
  select * into v_call from public.llm_calls where user_id = p_user_id and attempt_id = p_attempt_id for update;
  if found then
    if v_call.request_sha256 <> p_request_sha256 then raise exception 'attempt_conflict'; end if;
    return query select v_call.id, case when v_call.status = 'reserved' then 'pending'::text else 'settled'::text end;
    return;
  end if;
  select * into v_price from public.llm_price(p_provider,p_model);
  if not found then raise exception 'provider_not_configured'; end if;
  v_amount := ceil((v_price.max_input_tokens::numeric * v_price.input_usd_micros_per_million
    + v_price.max_output_tokens::numeric * v_price.output_usd_micros_per_million) / 1000000)::bigint;
  insert into public.llm_calls(user_id,attempt_id,provider,model,proposer,rule_id,context_sha256,request_sha256,
    budget_scope,budget_period_key,status,reserved_usd_micros)
  values(p_user_id,p_attempt_id,p_provider,p_model,p_proposer,p_rule_id,p_context_sha256,p_request_sha256,p_scope,v_period,'reserved',v_amount)
  on conflict (user_id, attempt_id) do nothing returning id into v_id;
  if v_id is null then
    -- Concurrent unique-key loser waits for the winning transaction; it must never execute the provider.
    select * into v_call from public.llm_calls where user_id = p_user_id and attempt_id = p_attempt_id for update;
    if not found then raise exception 'attempt_in_progress'; end if;
    if v_call.request_sha256 <> p_request_sha256 then raise exception 'attempt_conflict'; end if;
    return query select v_call.id, case when v_call.status = 'reserved' then 'pending'::text else 'settled'::text end;
    return;
  end if;
  if p_scope = 'demo' then
    -- Fixed global -> user order on both reservation and settlement. No caller-controlled daily period/cap.
    select * into v_settings from public.llm_budget_settings();
    insert into public.budgets(scope,user_id,period_key,cap_usd_micros) values('global',null,v_period,v_settings.global_daily_cap_usd_micros)
      on conflict (period_key) where scope = 'global' do nothing;
    select * into v_global from public.budgets where scope = 'global' and period_key = v_period for update;
    insert into public.budgets(scope,user_id,period_key,cap_usd_micros) values('user',p_user_id,v_period,v_settings.user_daily_cap_usd_micros)
      on conflict (user_id, period_key) where scope = 'user' do nothing;
    select * into v_user from public.budgets where scope = 'user' and user_id = p_user_id and period_key = v_period for update;
    if v_global.used_usd_micros::numeric + v_global.reserved_usd_micros + v_amount > v_global.cap_usd_micros
      or v_user.used_usd_micros::numeric + v_user.reserved_usd_micros + v_amount > v_user.cap_usd_micros then
      raise exception 'budget_exceeded';
    end if;
    update public.budgets set reserved_usd_micros = reserved_usd_micros + v_amount where id in (v_global.id,v_user.id);
  else
    -- Only an owner-precreated operator/run row authorizes eval spending; no inserts or demo-row charges.
    select * into v_eval from public.budgets where scope = 'eval_run' and user_id = p_user_id and period_key = v_period for update;
    if not found then raise exception 'budget_not_found'; end if;
    if v_eval.used_usd_micros::numeric + v_eval.reserved_usd_micros + v_amount > v_eval.cap_usd_micros then raise exception 'budget_exceeded'; end if;
    update public.budgets set reserved_usd_micros = reserved_usd_micros + v_amount where id = v_eval.id;
  end if;
  return query select v_id, 'new'::text;
end;
$$;
revoke execute on function public.reserve_llm_call(uuid,text,text,uuid,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.reserve_llm_call(uuid,text,text,uuid,text,text,text,text,text,text) to service_role;

create function public.settle_llm_call(p_call_id uuid, p_status text, p_input_tokens integer, p_output_tokens integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_call public.llm_calls%rowtype;
  v_price record;
  v_cost bigint;
  v_global public.budgets%rowtype;
  v_user public.budgets%rowtype;
  v_eval public.budgets%rowtype;
begin
  if p_status is null or p_status not in ('ok','abstain','schema_reject','screened','error','timeout','unknown_charge')
    or p_input_tokens < 0 or p_output_tokens < 0 then raise exception 'bad_request'; end if;
  select * into v_call from public.llm_calls where id = p_call_id for update;
  if not found then raise exception 'bad_request'; end if;
  if v_call.status <> 'reserved' then return; end if; -- Exactly-once charging; safe duplicate settlement.
  if p_status in ('unknown_charge','timeout') or p_input_tokens is null or p_output_tokens is null then
    v_cost := v_call.reserved_usd_micros;
  else
    select * into v_price from public.llm_price(v_call.provider,v_call.model);
    if not found then
      v_cost := v_call.reserved_usd_micros; -- Disabled/changed pricing cannot release an unknown charge.
    else
      v_cost := least(v_call.reserved_usd_micros,
        ceil((p_input_tokens::numeric * v_price.input_usd_micros_per_million
          + p_output_tokens::numeric * v_price.output_usd_micros_per_million) / 1000000)::bigint);
    end if;
  end if;
  if v_call.budget_scope = 'demo' then
    -- Use the reservation's UTC period, even after midnight. Never look up today's date here.
    select * into v_global from public.budgets where scope = 'global' and period_key = v_call.budget_period_key for update;
    if not found then raise exception 'budget_not_found'; end if;
    select * into v_user from public.budgets where scope = 'user' and user_id = v_call.user_id and period_key = v_call.budget_period_key for update;
    if not found then raise exception 'budget_not_found'; end if;
    if v_global.reserved_usd_micros < v_call.reserved_usd_micros or v_user.reserved_usd_micros < v_call.reserved_usd_micros then
      raise exception 'reservation_accounting_error';
    end if;
    update public.budgets set reserved_usd_micros = reserved_usd_micros - v_call.reserved_usd_micros,
      used_usd_micros = used_usd_micros + v_cost where id in (v_global.id,v_user.id);
  else
    select * into v_eval from public.budgets where scope = 'eval_run' and user_id = v_call.user_id and period_key = v_call.budget_period_key for update;
    if not found then raise exception 'budget_not_found'; end if;
    if v_eval.reserved_usd_micros < v_call.reserved_usd_micros then raise exception 'reservation_accounting_error'; end if;
    update public.budgets set reserved_usd_micros = reserved_usd_micros - v_call.reserved_usd_micros,
      used_usd_micros = used_usd_micros + v_cost where id = v_eval.id;
  end if;
  update public.llm_calls set status = p_status, input_tokens = p_input_tokens, output_tokens = p_output_tokens,
    cost_usd_micros = v_cost, settled_at = clock_timestamp(),
    latency_ms = least(2147483647, greatest(0, ceil(extract(epoch from (clock_timestamp() - created_at)) * 1000)))::integer
    where id = v_call.id;
end;
$$;
revoke execute on function public.settle_llm_call(uuid,text,integer,integer) from public, anon, authenticated;
grant execute on function public.settle_llm_call(uuid,text,integer,integer) to service_role;
-- At activation freeze pricing for the complete run; changes to prices mid-run are not validated here.
