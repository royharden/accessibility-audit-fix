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
