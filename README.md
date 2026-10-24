# Accessibility Audit-and-Fix Verifier

Audit one HTML page with a pinned axe-core, let a proposer suggest each fix as a few whitelisted JSON edit ops, splice
them into a scratch copy of the source, re-audit the whole page, and let a code gate decide
`verified | checked | rejected | inconclusive | needs_human`. It is a measurement project, not a WCAG-conformance claim:
the point is a measured gate error rate against weaker gates (target-only, score-delta, region-scoped).

## Status: built source only, never installed or run

This repository was written under **Dirty Mode** (static checks only). Nothing here has been installed, type-checked,
linted, tested, built or run:

- no `npm install` has happened; every dependency version in `package.json` is the placeholder
  `0.0.0-PIN-AT-ACTIVATION`, so `npm install` fails until the versions are pinned at activation;
- no lockfile exists; TypeScript must be **>= 5.8** (`erasableSyntaxOnly`), ESLint >= 9 (flat config);
- test files under `tests/` are written, not run;
- `engine-profile.json` is declared, not measured;
- there are no results: the README will quote only `results/results.md` once an eval has actually run.

The only check performed is a syntax parse of every `.ts` / `.mjs` / `.js` file (see `docs/DEFERRED-VALIDATION.md`).
A parse is not a type check.

## Milestones

| Milestone | Scope | State |
|---|---|---|
| M1 | Scaffold, shared contracts (rules, ops schema, rule-op matrix, value gates, BCP 47, local screen), audit types | source written |
| M2-M8 | HTML core, audit engine and gates, proposers and traps, fixtures and eval, backend and models, review UI, close | not started |

`index.html` references `src/app/main.tsx`, which lands in M7, so `npm run dev` has no entry module yet.

## Layout (so far)

- `src/shared/` — canonical copies, copied byte-identically into the edge function later (except `deps.ts`): relative
  imports inside `src/shared` only, explicit `.ts` extensions, `deps.ts` is the only `zod` import.
- `src/core/` — pure, isomorphic core (no DOM globals, no `node:*`); re-exports `src/shared`.
- `scripts/check-syntax.mjs` — the Dirty Mode syntax check.

## Licence

MIT (see `LICENSE`). axe-core (MPL-2.0) is used only as an unmodified dependency once installed.
