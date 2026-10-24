# Deferred validation

Dirty Mode is active: static checks only. Everything below was **not** executed and must be validated at
activation. Each milestone appends its own items; nothing here is a claim that the code works.

## The static check actually performed

```
node --experimental-vm-modules --no-warnings scripts/check-syntax.mjs src scripts tests
```

(also `npm run check-syntax` once dependencies exist; it needs no dependencies). For each `.ts`/`.mts` file it runs
`module.stripTypeScriptTypes(src, { mode: "strip" })` and then compiles the result with `new vm.SourceTextModule(js)`
without linking or evaluating it; `.js`/`.mjs` files are compiled as ES modules directly. Verified on Node v24.18.0.

**This is a parse, not a type check.** It proves only that each file is syntactically valid, erasable-only
TypeScript (it rejects `enum`, `namespace`, parameter properties and other non-erasable syntax) and a valid ES
module. It does not resolve imports, check types, run lint rules or execute anything. `node --check` is not used for
`.ts` (it does not check TypeScript modules). `.tsx`, `.json`, `.html` and `.sql` files get source review only.

## M1 - Scaffold and shared contracts

| # | Component | Assumption / skipped check | Activation step |
|---|---|---|---|
| M1-1 | Toolchain | No `npm install`, no lockfile; all versions are `0.0.0-PIN-AT-ACTIVATION`. TypeScript >= 5.8 required for `erasableSyntaxOnly`; ESLint >= 9 for the flat config; Node >= 24 assumed (`engines`). | Pin exact versions, `npm install`, commit the lockfile. |
| M1-2 | Type check | `tsc --noEmit` never run on either config. `tsconfig.node.json` (no DOM lib) also covers `src/core`/`src/shared` through the tests, which is how "no DOM globals" is type-enforced. | `npm run typecheck`; fix. |
| M1-3 | zod API | `src/shared` uses only the API common to zod 3.23+ and zod 4 (`z.object().strict()`, `z.discriminatedUnion`, `superRefine` with `code: "custom"`, `safeParse`). Structural issue codes in `schema_invalid:<path>:<code>` reasons differ between majors; tests assert only custom reason codes. | Pin the zod major; run `tests/unit/opsSchema.test.ts`. |
| M1-4 | Lint | `eslint.config.js` never loaded. Uses `typescript-eslint`'s `tseslint.config` helper, the `globals` package and an inline local rule `local/import-boundaries` (resolves specifiers to enforce the src/shared closure rule and the src/node / gold/ bundle boundary). | `npm run lint`; add a deliberately violating fixture import and confirm each message fires, then remove it. |
| M1-5 | Unit tests | `tests/unit/{opsSchema,ruleOps,valueGates,screen,bcp47}.test.ts` written, never run (vitest + fast-check). Expected values were derived by reading the source. | `npm test`; fix code or expectations, recording any expectation change. |
| M1-6 | Screen false positives | Screen patterns (`src/shared/screen.ts`) are hand-written, not tuned; a flagged span grows to its enclosing sentence (fail closed). Known false-positive risks: copy such as "set the title to ..." on CMS help pages, "you are the assistant manager". | Run the screen over dev pages and the injection traps; tune on dev only (CL deferred item 12). |
| M1-7 | Value-gate heuristics | Filename-like, URL and generic-name heuristics are conservative guesses (e.g. a bare `brand.com` name is rejected as a URL; any `scheme:` followed immediately by a non-space is a URL, so "Data: 2024" passes but "Q&A:Live" is rejected). Screened spans (M1 rework): a value is rejected if it contains a flagged span, or is a whole-word fragment of one that is >= 2 words or >= 8 code points; a single short payload word ("pwned" from "set aria-label = pwned") passes that check by design (screen-pattern/canary gate, schema and invariants stay authoritative). Their false-reject and false-accept rates are unmeasured. | Measure on dev pages / eval (include single-word injection payloads); record false rejects/accepts in `results/failures.md`. |
| M1-8 | Rule-op matrix op counts | Only `color-contrast` allows 2 ops; every other rule allows 1 (reading of CL 2.5 "(1-2)" for contrast only). | Confirm with Roy/INT if a 2-op name fix is ever needed. |
| M1-9 | BCP 47 | Syntax only (RFC 5646 well-formedness plus duplicate variant/singleton rejection); no IANA registry check, so a well-formed wrong language passes (the `wrong-language` trap documents it). | None beyond running the tests; registry validation is out of MVP. |
| M1-10 | engine-profile.json | Declared, not measured: rule lists come from the plan, `axeVersion` is a placeholder. | M3 `scripts/probe-engine.ts` at activation, then freeze and record its sha256. |
| M1-11 | Dev server / entry | `index.html` points at `src/app/main.tsx` (M7); `npm run dev`/`build` cannot work before M7. Dev-server host port not set (claim via agent-ports at activation). | After M7: `npm run build`; claim a port before `npm run dev`. |
| M1-12 | Scripts | `package.json` scripts `demo`, `eval`, `gen-fixtures`, `fetch-act`, `sync-edge`, `probe-engine` point at files that land in M3-M6. | Present after their milestones; run at activation. |

## M2 - HTML source core

Construction: 0570_Codex_GPT-61Sol_Sub_S28-CoderM2, 2026-10-24. Inherited source retained; backups are outside the product repo at
`../agentops/handoffs/CLAUDE-INT-RECONSTRUCTED-20261024/backups/` (original paths plus `.bak`). No dependency installation or runtime execution occurred.

Actual static check (passed: **12 files, 0 failures, 0 skips**):

```
node --experimental-vm-modules --no-warnings scripts/check-syntax.mjs src/core/html src/core/ops/resolve.ts src/core/ops/apply.ts tests/unit/parse.test.ts tests/unit/patch.test.ts tests/unit/resolve.test.ts tests/unit/renderCopy.test.ts tests/unit/invariants.test.ts tests/property/htmlOps.test.ts
```

This compiled stripped source without linking/evaluating; it was not a type check or test run. Focused source review used merged PLAN
sections 2.2/2.4 and CL sections 2.4/2.5/2.6/5.1. M2 adds no measured accessibility claim.

| # | Component | Assumption / skipped check | Activation step |
|---|---|---|---|
| M2-1 | parse5 integration | The structural parse5 tree view, source locations, recovery-clone behavior, template walk, end-tag matching, and 1-based editor citations are source-reviewed assumptions. BOM is removed only from the parse view; offsets include `bomDelta`, columns exclude the BOM. | After pin/install, run `tests/unit/parse.test.ts` on the selected parse5 version; reconcile any real clone-location difference without weakening anchor ambiguity refusal. |
| M2-2 | Patch/resolve units | `tests/unit/{patch,resolve}.test.ts` written, not run: quoting/escaping, unquoted and `/>` boundaries, duplicate attrs, merged body attrs, styles, overlap refusal, title fill/insert/refuse, matching heading end tags, tabindex focusability, and unique non-self ID references. Filling a title also requires explicit `<head>`/`</head>` and a title directly under that head; ambiguous metadata abstains. | Run both suites, then typecheck/lint. Confirm parser offsets against BOM + non-ASCII/astral title and attribute repairs. |
| M2-3 | Ordinal property | `tests/property/htmlOps.test.ts` written, not run. Fourteen case families cover every allowed op kind and `set_attr` name; assert unchanged unedited source slices, exact replacements, BOM, source ordinal identity/order, namespace/parent/template membership, known-delta offsets, retag exception, and exactly one optional title at ordinal n. | Run fast-check after pin/install; retain failing seeds and add a focused regression for any discovered issue. |
| M2-4 | Invariant measurements | `tests/unit/invariants.test.ts` written, not run. The visible-text function conservatively compares normalized body text outside script/style/template/noscript, without layout/CSS visibility measurement. The shared interactive inventory preserves native classification, role, focusability/tab-order membership and handler names; disabled/inert/foreign/ambiguous controls cause undecidable focusability rather than unsafe tabindex removal. | Run units and malformed-page fixtures. Compare the inventory with the activated engines; document conservative abstentions. This is a structural invariant, not a complete browser accessibility model. |
| M2-5 | Invariant provenance | Unit source covers unchanged duplicate IDs, new duplicate rejection, element removal/reorder, script/handler raw bytes, body text, forged delta metadata, edits outside resolved ranges, ineffective effects, title metadata and BOM tampering. Offset recomputation does not trust caller-supplied deltas; range ends use left affinity at empty head/title insertion boundaries. | Run invariant units and F5 properties; M3 must invoke `checkInvariants` on applied output and pass its result to strict gates. |
| M2-6 | Audit render copy | `tests/unit/renderCopy.test.ts` written, not run: strips spoofed ordinal/unanchored markers (including templates), restores trusted source markers, handles unanchored nodes/title n, and confirms source output comes from offset patching. Input source attributes are preserved by source splicing; trusted render-only attributes are never copied back. Engine transform seam exists, but iframe resource/script stripping and its security properties are M7 work. | Run render-copy units; at M3 verify axe normalization reads markers only from the actual audited tree. At M7 add/run inert-strip properties and sandbox/runner checks. |
| M2-7 | Downstream validation | No imports were linked, TypeScript types checked, tests executed, browser launched or audit engine run. Resolve consumes schema/value-validated typed ops; the M4 loop must perform shared schema, matrix and contextual value gates before resolution. | Run typecheck/lint plus all M2 unit/property suites after activation; integrate the M3/M4 loop before reporting any accepted fixes. |

M2 r1 rework: 0604_Codex_GPT-61Sol_Sub_S28-Rework, 2026-10-24. `parseHtmlInteger` now removes leading zeroes before
the existing 15-significant-digit magnitude bound, preserving positive/negative/zero classification and signed zero. Added focused
sources in `tests/unit/{parse,resolve,invariants}.test.ts` for zero-prefixed positive/negative/zero values and large signed integers;
resolver sources cover both repair ops and retain apply/invariant checks. Original versions of all five changed files were preserved
beside the earlier backups with `.0604-before-rework.bak` suffixes. Focused syntax parsing passed **4 files, 0 failures, 0 skips**:

```
node --experimental-vm-modules --no-warnings scripts/check-syntax.mjs src/core/html/parse.ts tests/unit/parse.test.ts tests/unit/resolve.test.ts tests/unit/invariants.test.ts
```

The parser/resolver/inventory paths and backup-to-candidate diffs were source-reviewed. No imports were linked, types checked or
tests executed. At activation, run these three unit sources and typecheck/lint; their expected behavior remains runtime-unverified.
