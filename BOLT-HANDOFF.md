# Bolt infrastructure handoff: Accessibility Audit-and-Fix Verifier

## Target and readiness

- Repository: local inner `accessibility-audit-fix` Git repository, branch `main`; no remote. Prepared source revision is the final M8 local commit recorded in outer STATUS.md.
- App root: this repository. Intended database target: Bolt Database using the Supabase-compatible contracts in source; fresh empty target proposed. Actual project ID, connection and migration baseline: **Unknown**.
- Hosting: intended Bolt hosting, not configured. Publication: prepare only; no push, import, provisioning or publication authorized/performed.
- Bolt action: **inspect and prepare only**. Source construction complete; not locally ready. Runtime and infrastructure unverified.
- Owner prerequisites: explicitly authorize activation first; pin dependencies/models/prices, choose intended backend, provide accounts/keys through settings and later authorize any GitHub remote/import separately.

## Build and connection

| Item | Command/configuration | Current outcome |
|---|---|---|
| Runtime | Node >=24; TypeScript >=5.8, React 18, ESLint >=9 | Versions not installed or verified as a compatible set |
| Install | Replace every 0.0.0-PIN-AT-ACTIVATION, initial reviewed npm install, commit lockfile; thereafter npm ci | No install or lockfile |
| Dev/build | npm run dev / npm run build; output dist | Never run |
| Checks | npm run typecheck, npm run lint, npm test | Never run; syntax parse only is not a substitute |
| Public client | src/app/lib/supabase.ts; VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY | Missing/invalid config produces offline setup state |
| Operator CLI | S28_OPERATOR_EMAIL plus same public project config; hidden TTY password prompt | No credentials accessed/login performed |
| Demo | Offline rules/mock plus in-memory rulings | Explicit synthetic mode; runtime unverified |

## Database

| Order | Migration | Resources | Applied |
|---|---|---|---|
| 1 | supabase/migrations/20261024000100_rulings.sql | rulings, own-user select/insert RLS, generated seq, no update/delete | Pending |
| 2 | supabase/migrations/20261024000200_llm_calls_budgets.sql | llm_calls, budgets, scope/period identities and RLS | Pending |
| 3 | supabase/migrations/20261024000300_budget_rpcs.sql | llm_price, llm_budget_settings, has_eval_budget, reserve_llm_call, settle_llm_call; service-only grants | Pending |

Owner-bound identities use auth.uid; browser clients may append their own rulings and read their own permitted rows. They cannot set budgets/prices, call service RPCs or alter history. Identity sequence permissions are included. No storage bucket, Realtime publication, job extension or external seed is required.

Inspect actual migration history/schema before applying anything. Apply only pending migrations to the intended connection, preserve data, inspect timeout outcomes before retry, and report drift. Never drop/recreate a database to force a demo. SQL is manually reviewed source, never applied.

An owner/service administrator must create the operator auth user and the eval budget, after verifying its UID and a unique run key. Example parameterized owner SQL (bind verified UID to $1 and reviewed run key to $2, not a browser request):

```sql
insert into public.budgets(scope, user_id, period_key, cap_usd_micros)
values ('eval_run', $1::uuid, $2::text, 15000000)
on conflict do nothing;
```

Read the resulting row and its cap/usage/reservations; a conflict is not proof that the intended cap exists. Never reset existing used/reserved amounts. No client enrollment/top-up route exists. Default demo proposals are $2 global/day and $0.25 user/day; eval proposal is $15/run. Prices/models remain inactive. Verify rate units, token limits, rounding and provider billing before activation.

## Functions

| Source | Caller/auth | Contract and resources | Configuration |
|---|---|---|---|
| supabase/functions/propose-fix/index.ts and complete shared copies | Browser/operator user JWT, gateway verify_jwt=true plus handler getUser | Strict ProposeRequest/ProposeResponse; llm_calls/budgets service RPCs; Anthropic, OpenAI-compatible, TypeSafe | supabase/config.toml |

The service client is created only after user verification. Authenticated UID, never supplied UID, owns calls. Exact attempt identity binds request/context hashes; duplicate/in-progress/settled attempts cannot create fresh calls. Server computes reservations and locks budgets; eval_run uses its own grant, never demo caps. Settlement uses the stored period across midnight and conservative unknown-charge accounting.

CORS_ALLOWED_ORIGINS is a comma-separated exact browser-origin allowlist. POST/OPTIONS allow authorization, x-client-info, apikey and content-type. Originless operator requests still require auth. Context is at most 4KB, body 16KB, provider call 20s within 30s overall edge deadline; actual platform deadlines/cancellation need validation. No hidden provider retries or redirected credentials.

JWT signing-key compatibility with gateway verify_jwt=true is pending. If the selected platform requires a configuration adjustment, inspect official platform requirements and retain handler getUser as mandatory; do not turn the function into a public paid endpoint.

## Server secrets to enter through settings

| Name | Consumer / requirement | Owner source |
|---|---|---|
| ANTHROPIC_API_KEY | propose-fix llm-A | Chosen Anthropic account |
| OPENAI_COMPATIBLE_API_KEY | propose-fix llm-B | Chosen compatible provider |
| OPENAI_COMPATIBLE_BASE_URL | propose-fix llm-B fixed allowlisted destination configuration | Reviewed provider endpoint |
| TYPESAFE_API_KEY | Optional Jev Choice/Noul | TypeSafe account, only after calibration/billing review |
| SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY | Injected platform configuration, verify availability | Intended backend only |
| CORS_ALLOWED_ORIGINS | Server origin configuration, not a credential | Final reviewed app origins |

No values are present or requested in source. Missing secrets/model prices yield an explicit not-configured response, never fabricated live output. Never expose server keys using VITE_ prefixes or put them in CLI env. Actual A/B model IDs are placeholders. Jev comparison pin is jev-1.13.0, unverified at runtime. Provider B uses max_completion_tokens; validate the chosen model supports its exact parameters. TypeSafe's documented contract has no output-cap parameter: verify worst-case billing fits the SQL 1024-output reservation, or revise both contracts before enabling prices. Jev remains disabled/unretained.

## Auth, storage, and external steps

- Enable intended anonymous demo sign-in and an owner-created email/password operator. Check whether disabling sign-ups also prevents anonymous access or the operator's email login before choosing settings. Email sign-up alone grants only demo scope, never eval enrollment.
- Final site URL/recovery configuration depends on the eventual hosting origin; no callback/recovery route is implemented here. UI uses explicit passwordless anonymous demo access; operator password sign-in is CLI-only. Operator signs out locally; browser SDK can restore a persisted session.
- Buckets, Realtime, schedulers, long-job workers, webhooks and OAuth registrations: not required by this source.
- Real adapter sources: Anthropic, OpenAI-compatible and TypeSafe. No real round trips occurred. Demo/mock are explicitly synthetic.
- No database, function, secret, auth setting, dataset download or cloud resource was created.

## Acceptance checks and receipts

Every runtime/cloud check below is **pending**, not inferred from static source review.

| Check | Required evidence |
|---|---|
| Install/type/lint/test/build | Exact pins and lockfile, successful actual command outputs, resolve integration/type errors |
| Engine probe | Actual axe version/rules, jsdom skips, iframe CSP/network isolation, fixed viewport, freeze measured profile/hash |
| Corpus/demo | Freeze generated manifest, actual detected quota/shortfall counts, five-state demo and UI journey |
| Auth and RLS | Two-user isolation, no updates/deletes, own-call reads, no direct client service RPC/budget writes |
| Reservations | Concurrent caps, idempotent attempts, request mismatch, midnight settlement, unknown charge, eval/demo separation |
| Providers | Tiny authorized calls within limits, schema/usage correctness, cancellation, actual ledger and server prices |
| Jev | Billing bound, dev calibration, frozen thresholds, heldout win before default retention, provenance-safe cache |
| Evaluation | First-pass shared stream, strict retry only, unknown denominators, real Wilson tables, failures and cost provenance |
| ACT | Reviewed terms/URLs/pins, explicit fetch only, separate actual-n table, no false semantic labels |
| UI/export | Approve/reject/skip, uncertain writes, paginated history, auth/source stale invalidation, combined blocked/ready paths |
| Bolt import/schema/function | Intended project/baseline, migration receipts, deployed authenticated round trip and missing-secret behavior |
| Publication | Not authorized; requires a later explicit grant |

See docs/DEFERRED-VALIDATION.md for detailed cases. Static reviewer passes mean construction acceptance only. They are not deployment or product acceptance.

## One prompt after GitHub import

> Read BOLT-HANDOFF.md and inspect the imported source at the intended branch/revision. Compare proposed resources with implemented files, reconcile unknown migration baselines through read-only history/schema inspection when access is available, and report concrete deployment gaps and owner/external blockers. Preserve the app design and existing database/data. Prepare a reviewable setup plan with actual file/resource names and pending checks. Do not create or change cloud resources, apply migrations, deploy functions, enter secrets, enable schedules, or publish. Do not describe proposed resources or unexecuted checks as complete. This repository has placeholder dependencies and no runtime validation; activation and import require separate authorization.
