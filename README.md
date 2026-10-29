# Accessibility Audit-and-Fix Verifier

Audit an HTML page, propose small whitelisted JSON edits, splice them into a scratch copy, and re-audit the whole page. The code gate distinguishes `verified`, `checked`, `rejected`, `inconclusive`, and `needs_human`. Every exported change also needs exact human approval and a successful combined-page audit.

This is a gate-measurement project. Passing axe or the strict gate does not establish semantic correctness or WCAG conformance. The planned experiment compares target-only, score-delta, region-scoped and strict gates against independent fixture truth. Wrong-language proposals deliberately expose a possible strict-gate false acceptance.

**Planned headline (N and all result counts are unmeasured):** On N held-out planted defects, per gate (target-only, score-delta, region-scoped, strict) we will report how many first-pass fixes each accepted, how many of those a hidden semantic oracle marks wrong, and how many correct fixes each rejected, with mechanical and content buckets kept separate; per-rule and per-proposer verified/checked rates will follow.

## Source construction and pending activation

M1–M8 sources are present. Construction occurred under Dirty Mode: **no dependencies installed, type checks, lint, tests, builds, app runs, provider calls, database changes or deployment performed**. Test sources are written but unexecuted. Dependency versions are `0.0.0-PIN-AT-ACTIVATION`, there is no lockfile, and the repository is not runnable until compatible packages are pinned. Static TypeScript syntax parsing is not type checking; TSX, SQL, CSS and HTML received source inspection only.

`engine-profile.json` remains `declared_not_measured`. Corpus generation, the frozen manifest, actual detection quotas, live budgets, model compatibility, Jev calibration/retention and result numbers remain pending. [Results](results/results.md), [failures](results/failures.md), [deferred validation](docs/DEFERRED-VALIDATION.md) and [Bolt handoff](BOLT-HANDOFF.md) record these limits.

## Layout

| Source | Responsibility |
|---|---|
| `src/shared`, `src/core` | Strict contracts, offsets, source-preserving edits, invariants, gates, retries, reports and exact approvals |
| `src/engines/iframe` | Isolated, stripped iframe UI engine |
| `src/node/jsdomEngine.ts` | Node-only jsdom CLI engine |
| `src/app` | React review UI, explicit demo/rules/live modes, rulings and patch/JSON download |
| `src/node`, `scripts`, `gold` | Synthetic generator, private oracle, checkpoint/ledger, evaluation and explicit ACT fetch |
| `supabase` | Three migration sources and authenticated, budgeted `propose-fix` edge function |
| `fixtures/traps`, `fixtures/proposals` | Scripted adversarial replays; no measured efficacy claim |

Input is at most 200,000 UTF-8 bytes. Baseline auditing covers the complete page; proposal selection stops at the first 50 eligible findings, leaving the rest visible as not attempted. Four mechanical rules can reach `verified`; six content rules remain `checked` and require judgment. jsdom cannot measure contrast or visible-name mismatch; reports preserve that distinction.

## Activation commands — not executed

First close Dirty Mode explicitly, pin compatible exact dependencies (Node >=24, TypeScript >=5.8, React 18 and ESLint >=9), install and commit a lockfile. Then perform [deferred validation](docs/DEFERRED-VALIDATION.md): `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, engine probe and fixture generation before evaluation. After the first reviewed install, use `npm ci`. This command list is not execution evidence.

Intended entrypoints include `npm run demo`, `npm run eval -- --proposers rules,mock`, and `npm run fetch-act -- --manifest <reviewed-pin-manifest.json>`. Paid CLI methods `llm-A`, `llm-B` and `jev` use the authenticated edge route and require `--run-key` backed by an owner-created eval budget. They never receive provider secrets.

Jev's current policy has all four flags false and null thresholds, so `--experimental-jev` still cannot call. The flag waives only the `retained`/`heldoutWin` requirement for a policy already configured with `enabled=true`, `devSelected=true` and valid non-null thresholds; it does not enable the policy or select thresholds. Optional `--jev-triage` requires the same ready policy and a non-mock base proposer.

`--act` reads previously fetched, pinned local cases without fetching during evaluation. `--act-only` implies `--act` and skips synthetic gold/trap inputs; `--act-only --proposers mock` is rejected because mock has only trap scripts. See [evaluation](docs/EVAL.md).

The offline demo needs no backend. Live operation requires public `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, deployed migrations/function, auth and server secrets. Operator CLI additionally uses `S28_OPERATOR_EMAIL` and a hidden in-memory password prompt. No credentials or backend readiness were verified.

[Architecture](docs/ARCHITECTURE.md), [limitations and adopted deviations](docs/LIMITATIONS.md), [threat model](docs/THREAT-MODEL.md), [NOTICE](NOTICE), [VENDORED](VENDORED.md). Own code is MIT. Intended axe-core use is an unmodified MPL-2.0 dependency; installed notices must be checked at activation.
