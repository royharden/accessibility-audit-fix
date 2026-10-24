# Threat model

This is a source-reviewed design, not a tested security claim. [Deferred validation](DEFERRED-VALIDATION.md) is required before live use.

| Boundary | Intended controls | Remaining evidence needed |
|---|---|---|
| Hostile HTML to parser/UI | Byte cap, offset-based allowlist, escaped source/diff, no dangerous HTML display | Malformed parser cases, BOM/offset properties, actual React rendering |
| HTML to iframe | Opaque sandbox, nonce CSP, stripping handlers/scripts/resources/navigation, trusted bounded protocol | Browser network/CSP probes, forged message/token/source cases, timeout cleanup |
| Context to models | Bounded minimal excerpts, screen before calls, strict typed responses, no full source transport | Injection/false-positive trials, actual provider schema behavior |
| Browser/operator to edge | User JWT, getUser, strict body, CORS allowlist, server-selected model/price, no CLI provider secrets | Actual gateway signing compatibility, wrong-user/JWT/CORS tests |
| Edge to provider | Fixed/allowlisted destinations, no redirect or hidden retries, deadline/body bounds | Real cancellation and token/rate compatibility; TypeSafe output reservation bound |
| User to database | Per-user RLS, append-only rulings, own call reads, no client writes to budgets/prices/service RPCs | Two-user tests and direct REST/RPC privilege probes |
| Concurrent paid attempts | Request-bound attempt identity, lock ordering, worst-case reservation, exactly-once stored-period settlement | Races, duplicate calls, midnight boundary, unknown-charge recovery |
| Approval to export | Exact hashes, latest authoritative history, uncertain-write block, combined re-audit | Network-loss reconciliation, capped history, stale UI generation and composition tests |

Untrusted proposed text never becomes authority. A successful model response can still fail schema, value, matrix, invariants or audit. Noul may reject/route accepted content but cannot promote a rejected operation. Cached decisions retain original provenance and cannot fabricate a paid current attempt or usage.

The app does not persist full uploaded page bodies to its three tables or intentionally log full input source at the edge. Local reports, checkpoints, ledger/cache files and rulings may nevertheless contain proposed text, excerpts or metadata; review them before sharing. Browser Supabase sessions can persist/refresh through the SDK. Operator password/session is memory-only with local sign-out; actual auth/storage behavior must be verified. In-memory rulings are an explicit offline mode, never a silent fallback after a database failure.

Budget caps bound intended exposure, not semantic correctness. Failed/lost responses may incur conservative charges and need reconciliation; a cache hit must not charge again. Server pricing is inactive until exact model/rate/billing compatibility is verified. An owner-created eval budget cannot be enrolled or increased by the client. No keys, accounts, deployments or paid calls were accessed during construction.

The tool neither certifies WCAG compliance nor establishes that sanitized rendering represents a live site's behavior. No remote, cloud provisioning or publication is authorized by this source handoff.
