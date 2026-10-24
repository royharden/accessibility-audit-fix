import type { Finding } from "../audit/types.ts";
import type { ProposalContext } from "./context.ts";
import type { Op } from "../../shared/opsSchema.ts";
import type { GateResult } from "../gate/reasons.ts";
export interface CacheEvidence { readonly key: string; readonly originCallId: string; readonly originAttemptId: string }
export interface ReviewResponse { readonly decision: "pass" | "reject" | "route" | "inconclusive"; readonly reasons: readonly string[]; readonly cache?: CacheEvidence }

/** Unknown is deliberate: every proposer, including local rules and mock fixtures, crosses the same schema gate. */
export type ProposerResponse = (
  | { readonly kind: "proposal"; readonly value: unknown }
  | { readonly kind: "abstain"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reasons: readonly string[] }
  | { readonly kind: "inconclusive"; readonly reason: string }) & { readonly cache?: CacheEvidence };
export interface ProposalAttempt { readonly attempt: number; readonly reasons: readonly string[] }
export interface FixProposer {
  readonly id: string;
  readonly mode: "mock" | "live";
  /** Rules/remote need useful safe context; scripted mocks can still exercise value-gate rejection. */
  readonly requiresSafeContext?: boolean;
  propose(finding: Finding, context: ProposalContext, attempt: ProposalAttempt): Promise<ProposerResponse>;
  reviewAccepted?(finding: Finding, context: ProposalContext, ops: readonly Op[], codeGate: GateResult, attempt: number): Promise<ReviewResponse>;
}
