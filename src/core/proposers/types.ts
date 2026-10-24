import type { Finding } from "../audit/types.ts";
import type { ProposalContext } from "./context.ts";

/** Unknown is deliberate: every proposer, including local rules and mock fixtures, crosses the same schema gate. */
export type ProposerResponse =
  | { readonly kind: "proposal"; readonly value: unknown }
  | { readonly kind: "abstain"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reasons: readonly string[] }
  | { readonly kind: "inconclusive"; readonly reason: string };
export interface ProposalAttempt { readonly attempt: number; readonly reasons: readonly string[] }
export interface FixProposer {
  readonly id: string;
  readonly mode: "mock" | "live";
  /** Rules/remote need useful safe context; scripted mocks can still exercise value-gate rejection. */
  readonly requiresSafeContext?: boolean;
  propose(finding: Finding, context: ProposalContext, attempt: ProposalAttempt): Promise<ProposerResponse>;
}
