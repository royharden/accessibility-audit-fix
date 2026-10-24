// Ops schema and the per-rule matrix: canonical copies in src/shared (edge-copied); re-exported for src/core.
// ops/resolve.ts and ops/apply.ts (op -> edit ranges -> splice) land in M2.
export * from "../../shared/opsSchema.ts";
export * from "../../shared/ruleOps.ts";
