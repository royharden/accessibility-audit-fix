# Limitations and adopted decisions

No runtime validation or efficacy measurement has occurred. [Failures](../results/failures.md) is the generated failure-analysis destination and is currently not run; this document does not invent counts. [Deferred validation](DEFERRED-VALIDATION.md) lists activation work.

Axe passing is not correctness. The strict gate can accept a syntactically valid but wrong language, plausible yet incorrect alt text, or an inappropriate name. Human approval is necessary for export but is not an oracle or conformance certificate. The six content rules retain semantic uncertainty. The MVP supports ten eligible rules and a narrow edit whitelist, not arbitrary accessibility repair.

The iframe measures a stripped render copy at a declared 1280×900 viewport, with remote resources/navigation, scripts, handlers, nested content and resource-bearing CSS removed. Contrast on that copy is not evidence about the original page's pixels, responsive layouts or external stylesheet. The trusted audit loader changes the initial render DOM before measurement; its exact prepared input is hashed and its profile must be frozen. jsdom excludes contrast and cannot measure visible-name mismatch. Both profiles are unmeasured declarations.

Source citations exclude implied/cloned elements without unique source offsets. Malformed markup, duplicate IDs, ambiguous references, mapping failures and edit overlaps can force human/inconclusive states. Four-kilobyte proposer context may omit meaning. Prompt screening is heuristic, including short suspicious words; false positives and bypasses remain possible. Scripts/resources never execute from the input in the intended engine design, but sandbox/CSP behavior is untested.

Scripted trap outcomes are unit evidence, not measured generalization. The label-mismatch and injection traps can use scripted findings absent from real baseline axe. Actual iframe reproduction of visible-name mismatch and the gradient incomplete case is pending. Generated pages, heldout counts, ACT pins/terms, provider responses and Jev benefit are unmeasured. Unknown/unstable baseline observations and unknown oracle judgments remain visible.

Uncertain ruling writes block downloads until authoritative reconciliation. Large or nonprogressing history pagination fails closed rather than returning a partial approval history. Availability is sacrificed when authority cannot be established. SQL concurrency, auth isolation, exactly-once settlements and provider cancellation remain source claims requiring execution checks.

## Specification deviations C1–C21

| ID | Adopted scope |
|---|---|
| C1 | Drop set_attr for: the label association's idiomatic repair targets a different element and is outside MVP. |
| C2 | Drop remove_attr aria-hidden: it serves none of the ten rules. |
| C3 | Add exact tabindex=0 only for positive tabindex on non-native-focusable elements; uncertain focusability abstains. |
| C4 | Regression audit covers the full rule set, not only eligible rules. |
| C5 | Compare four gates on first pass; strict only after retries. |
| C6 | No language detector; wrong-language is a documented potential strict false acceptance. |
| C7 | Recheck combined export, block instead of trimming, require approval for every fix. |
| C8 | Global daily cap and server-derived, service-only budget amounts. |
| C9 | Exact five-field ruling key includes source, rule, ordinal, ops and profile. |
| C10 | Type/lint/tests/demo execution deferred under Dirty Mode. |
| C11 | Visible-name gate under jsdom is skipped_not_measured. |
| C12 | Only source-backed ordinals; clones/implied targets can be no_source_anchor. |
| C13 | Planning's DeepWiki folder had three exports; the old empty-folder description was stale. No export is bundled into runtime. |
| C14 | Fifty-item cap limits proposal queue, never the full baseline audit. |
| C15 | ID multiplicities unchanged/no new duplicates, rather than demanding preexisting IDs all be unique. |
| C16 | CLI JSONL plus app llm_calls replaces SQLite; eval.ts replaces old eval.py wording. |
| C17 | Superseded by K1: there is no direct-provider CLI spending route. |
| C18 | Latest ruling uses generated identity seq, not timestamps. |
| C19 | Empty alt only through mark_decorative, with semantic human review. |
| C20 | Preserve BOM in source/hash/export; parse using an explicit offset delta. |
| C21 | Adjacent repeated-text rejection applies to image alt; adjacent labels may legitimately supply accessible names. |

## Merged planning choices K1–K20

| ID | Adopted choice |
|---|---|
| K1 | Paid CLI calls propose-fix using operator JWT and an owner-created eval_run budget. |
| K2 | Detailed core layout, explicit Node boundary. |
| K3 | Migration date 20261024. |
| K4 | Identity seq determines ruling order. |
| K5 | Page-level region-scoped gate is n/a. |
| K6 | period_key text with global, user and eval_run scopes. |
| K7 | Operator email env allowed; password hidden and memory-only. |
| K8 | Preserve interactive role/focusability inventory, not only counts. |
| K9 | Duplicated aria-labelledby references abstain. |
| K10 | Total queue order ordinal then rule ID. |
| K11 | Double baseline; unstable means inconclusive. |
| K12 | Commit generator source; generate/freeze corpus only at activation. |
| K13 | Provider 20s plus overall 30s edge deadline; platform support pending. |
| K14 | attempt_in_progress / attempt_already_settled error vocabulary. |
| K15 | verify_jwt=true plus handler getUser; signing-key compatibility must be checked before any authorized configuration adjustment. |
| K16 | Select Jev point on dev; retain only after heldout win. Currently disabled and unretained. |
| K17 | Demo exercises mechanical/content approvals and rejection. |
| K18 | No CLI provider keys or client-controlled cost cap. |
| K19 | jsdom gets markers without stripping; it runs no input scripts/resources. Iframe strips. |
| K20 | Offline rules/mock need no database; paid CLI requires backend. |

These choices follow the outer immutable merged plan. Open owner defaults remain reversible: edge spending route, $2/$0.25 daily and $15 eval caps, actual A/B models and prices, exact dependency pins, no remote/publication, and provisioning-time auth settings. They do not block source construction.

Jev's documented HTTP request has no output-token cap parameter. Bounded question counts/response bytes and usage validation are implemented, but the worst-case billable TypeSafe response must be verified against the SQL 1024-output-token reservation contract before activating its prices. If it cannot be bounded that way, revise the provider and reservation contract together. No current default permits a paid Jev call.
