# Vendored code

**Nothing is vendored.** Outcome of the S11-S20 TypeScript module inventory (REV M7, PLAN.md M1):
**none compatible - minimal local contracts.**

## Inventory (M1, 2026-10-24, read-only)

Looked for TypeScript `evalkit`, `providers`, `callledger`, `rulings` and `cited` modules in the S11-S20 build
outputs under `PJ-OD\Bolt.New\` (inner repos `browser-doc-qa`, `policy-redflag-extension`, `file-declutterer`,
`forecasting-backtest`, `job-hunt-copilot`, `negotiation-sandbox`, `mcp-app-ui`, `memory-migrator`,
`self-falsifying-analysis`, `skill-eval-harness`) by file/directory name (`*evalkit*`, `*callledger*`, `*ledger*`,
`*ruling*`, `*cited*`, `providers`, `*wilson*`), excluding `node_modules`. `PortfolioBuilder\ideas\small-apps`
holds specs only (Markdown), no TypeScript sources.

| Module | Found | Decision |
|---|---|---|
| `evalkit` | no module of that name | local contracts (M5: manifest, eval runner, `results.md`) |
| `providers` | no shared module; `skill-eval-harness/runner/adapters/*` are CLI agent adapters (Claude/Codex process runners), not HTTP model providers | not compatible; local `src/shared/providers/*` (M6/M8) |
| `callledger` | none | local `src/node/fsLedger.ts` + `llm_calls` (M6) |
| `rulings` | none | local `rulings` table + `src/app/lib/rulingsStore.ts` (M6/M7) |
| `cited` | none | local `Cite {file,line,col}` in `src/core/audit/types.ts` (M1) |
| Wilson interval | `skill-eval-harness/supabase/functions/publish-run/domain/wilson.ts` at `0efd5bd` (MIT, Roy Harden 2026); one function, depends on `Z95` from its `types.ts` | not vendored in M1; M5 (`src/core/stats/wilson.ts`) either vendors it with this commit recorded here or reimplements it, and tests against known values either way |

The search was name-based and bounded (a few searches); a module with a different name could have been missed.
