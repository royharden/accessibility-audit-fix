# Architecture

This describes constructed source, not a running system. See [deferred validation](DEFERRED-VALIDATION.md).

## Audit and edits

The pure/isomorphic `src/core` imports no Node APIs or oracle truth. `src/shared` owns strict schemas, eligible rules, rule/op matrix, screening, wire contracts and provider adapters. Shared files are manually mirrored into `supabase/functions/propose-fix/shared`; `deps.ts` is the intentional dependency-resolution exception. The Node-only CLI, oracle, local filesystem ledger and corpus tools stay outside the public `src/index.ts` closure.

`parsePage` builds parse5-derived source-backed element ordinals and offsets. Ordinals cite original source, including identical siblings; implied elements cannot pretend to have editable offsets. UTF-8 byte limits and the BOM are preserved. `resolveOps` checks the rule/op matrix and exact target, then `applyEdits` splices whitelisted operations into source. It does not serialize an AST. A missing title has one controlled insertion; multiple edits cannot overlap.

The complete baseline runs before the deterministic first-50 eligible queue. Proposers receive a bounded, screened context, not the full source. An attempt passes schema/value checks, local invariants and a whole-page re-audit. Up to three attempts feed gate reasons back to the proposer; four-gate comparisons use first-pass proposals only.

Strict compares complete, error-free audits with identical engine, profile, axe version and not-measured rule sets. An unmapped target needs human review. A mapped target must be an eligible measured rule with a matching `rule:ordinal` fingerprint present in the baseline, then absent from both after violations and after incomplete findings. Across the full audited rule set, every after violation/incomplete fingerprint must already occur in the union of baseline violations and incomplete findings; a baseline-violation fingerprint appearing in the after-incomplete list is rejected as a downgrade. Impact/severity changes are not compared. Preexisting unmapped findings may remain: their counts must not increase for any rule/unmapped-reason pair, separately for violations and incomplete findings. The gate also requires preserved visible text/structure/handlers/IDs and applicable visible-name agreement. Rule-specific headings, tabindex and decorative-alt logic add constraints. Non-complete audit status, audit errors or mismatched measurement coverage make the comparison inconclusive.

States distinguish measured mechanical success (`verified`), code-accepted semantic content (`checked`), rejection, inconclusive execution and human-needed cases. Semantic oracle correctness is separate from both gate acceptance and approval.

## Engines and evidence

The jsdom engine has no resource loader and runs bundled axe on a render copy. Contrast is excluded; visible-name mismatch is explicitly not measured. The iframe engine uses a 1280×900 opaque sandbox with only `allow-scripts`, CSP nonces, no page scripts/handlers or external resources. Sanitization also neutralizes navigation, resource attributes, CSS resource constructs and nested-frame content. Raster data images are the narrow image exception. A trusted nonce bootstrap runs axe and removes its runner before auditing. The recorded render hash covers the exact prepared srcdoc input, including bootstrap/token metadata, rather than claiming to hash the post-bootstrap DOM.

Iframe replies require the expected source window, token, strict shape, size and deadline. Unprepared input is refused. Both engines map findings to original source and retain unmapped uncertainty. The exact engine-profile file bytes, source and audited render get SHA-256 evidence fields. Profiles remain declared, not measured; browser and Node results are separate.

## Review and export

Every fix, including mechanical ones, needs the latest exact ruling keyed by page SHA-256, rule, ordinal, SHA-256(JSON.stringify(ops)) and engine profile. Database rulings are append-only with monotonic identity sequences. Equal highest-sequence ambiguity confers no approval. History is keyset-paginated until empty; nonprogress or page-limit exhaustion fails closed.

Auth/source/generation changes invalidate stale UI work. An uncertain reject/skip write retains a local exact-key block until authoritative reconciliation; it cannot resurrect a cached approval. Export refreshes authoritative rulings and re-audits the complete nonoverlapping combined page. Failure produces blocked diagnostics and bisection information, never a downloadable patch. Source and diff are rendered as escaped text.

## Paid route and storage

Browser and operator CLI use the same JWT-authenticated `propose-fix` edge function. The handler verifies identity with getUser, screens bounded context, selects a fixed server provider/model and reserves a server-priced worst-case amount before a call. Call identity and request hashes prevent an attempt ID being reused for different input. Global/user demo budgets or an owner-created eval-run budget are charged under database locks; eval does not consume demo caps. Settlement is exactly once against the stored period, including midnight boundaries. Unknown charges reserve conservatively. No client can set prices or enroll/top up budgets.

The three tables are rulings, llm_calls and budgets. Model pricing/settings are service-only SQL functions, initially inactive with null prices. Provider secrets remain server-only. Complete request budgets include 4KB context, 16KB request body, 20s provider and 30s overall edge deadline. Browser/CLI have their own bounded transport deadline. Provider bodies are bounded and abort-aware.

Provider A is Anthropic; B is OpenAI-compatible. Model IDs/prices require activation pins. Optional TypeSafe Jev Choice is restricted to button/link/label candidate selection, including none; an empty candidate set cannot incur a call. Optional Noul triage can only reject/route already code-accepted content. It cannot promote a rejected fix or turn semantic content into mechanical verification. Default policy is disabled/unretained until actual calibration and heldout evidence. Cache hits preserve original provenance and incur no fabricated usage/current call. CLI cache is local JSONL; UI cache is memory, without a fourth database table.
