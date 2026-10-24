import type { AuditResult, Finding } from "../audit/types.ts";
import type { Op } from "../../shared/opsSchema.ts";
import type { ResolvedOps } from "../ops/resolve.ts";
import type { ApplySuccess } from "../ops/apply.ts";
import type { InvariantResult } from "../html/invariants.ts";
import type { GateResult } from "../gate/reasons.ts";

export type FixState = "verified" | "checked" | "rejected" | "inconclusive" | "needs_human";
export type AttemptStage = "context" | "proposal" | "schema" | "matrix" | "value" | "resolve" | "audit" | "gate";
export interface FixAttempt {
  readonly number: number;
  readonly state: FixState;
  readonly reasons: readonly string[];
  readonly stage: AttemptStage;
  readonly ops?: readonly Op[];
  readonly resolved?: ResolvedOps;
  readonly applied?: ApplySuccess;
  readonly after?: AuditResult;
  readonly gate?: GateResult;
  readonly invariants?: InvariantResult;
  readonly rendered?: string;
  /** Absent for schema/value rejection: those rows are outside gate-comparison denominators. */
  readonly variants?: { readonly targetOnly: GateResult; readonly scoreDelta: GateResult; readonly regionScoped: GateResult };
}
export interface FixResult {
  readonly finding: Finding;
  readonly proposer: string;
  readonly mode: "mock" | "live";
  readonly attempts: readonly FixAttempt[];
  readonly firstPass: FixAttempt;
  readonly final: FixAttempt;
}
