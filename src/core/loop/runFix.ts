import type { AuditEngine, AuditResult, Finding } from "../audit/types.ts";
import type { ParsedPage } from "../html/parse.ts";
import type { FixProposer } from "../proposers/types.ts";
import type { FixAttempt, FixResult } from "../ledger/types.ts";
import { buildContext } from "../proposers/context.ts";
import { isAbstain, parseProposal } from "../../shared/opsSchema.ts";
import { checkOpsForFinding } from "../../shared/ruleOps.ts";
import { checkProposalValues } from "../../shared/valueGates.ts";
import { isEligibleRule, bucketOf } from "../rules.ts";
import { gateResult } from "../gate/reasons.ts";
import type { ReviewResponse } from "../proposers/types.ts";
import { resolveOps } from "../ops/resolve.ts";
import { applyResolved } from "../ops/apply.ts";
import { checkInvariants } from "../html/invariants.ts";
import { strictGate, changedNameOrdinals } from "../gate/strict.ts";
import { regionScopedGate, scoreDeltaGate, targetOnlyGate } from "../gate/variants.ts";
import { MAX_ATTEMPTS, MAX_RETRY_REASONS } from "../limits.ts";

export interface RunFixInput {
  readonly page: ParsedPage; readonly finding: Finding; readonly baseline: AuditResult; readonly engine: AuditEngine;
  readonly proposer: FixProposer; readonly render: (source: string, insertedTitleStart: number | null) => string;
  readonly file?: string; readonly maxAttempts?: number;
}
export async function runFix(input: RunFixInput): Promise<FixResult> {
  const { page, finding, baseline, engine, proposer } = input;
  const attempts: FixAttempt[] = [];
  const bundle = buildContext(page, finding, input.file);
  const cap = Number.isFinite(input.maxAttempts) ? Math.max(1, Math.min(MAX_ATTEMPTS, Math.floor(input.maxAttempts ?? MAX_ATTEMPTS))) : MAX_ATTEMPTS;
  const attempt = async (number: number): Promise<FixAttempt> => {
    const stop = (state: FixAttempt["state"], stage: FixAttempt["stage"], reasons: readonly string[]): FixAttempt => ({ number, state, stage, reasons });
    if (baseline.status !== "complete" || baseline.errors.length > 0) return stop("inconclusive", "audit", ["baseline_not_complete"]);
    if (!isEligibleRule(finding.rule)) return stop("needs_human", "context", ["rule_not_eligible"]);
    if (finding.ordinal === null || finding.fingerprint === null) return stop("needs_human", "context", [finding.unmappedReason ?? "unmapped"]);
    if (baseline.notMeasured.includes(finding.rule)) return stop("inconclusive", "audit", ["target_not_measured"]);
    if (proposer.requiresSafeContext === true && bundle.blockedByScreen) return stop("needs_human", "context", ["screened"]);
    let response;
    try { response = await proposer.propose(finding, bundle.context, { attempt: number, reasons: attempts.at(-1)?.reasons.slice(0, MAX_RETRY_REASONS) ?? [] }); }
    catch { return stop("inconclusive", "proposal", ["proposer_error"]); }
    const stopped = (state: FixAttempt["state"], stage: FixAttempt["stage"], reasons: readonly string[]): FixAttempt => ({ ...stop(state, stage, reasons), ...(response.cache === undefined ? {} : { cache: response.cache }) });
    if (response.kind === "inconclusive") return stopped("inconclusive", "proposal", [response.reason]);
    if (response.kind === "abstain") return stopped("needs_human", "proposal", [response.reason]);
    if (response.kind === "rejected") return stopped("rejected", "schema", response.reasons);
    const parsed = parseProposal(response.value);
    if (!parsed.ok) return stopped("rejected", "schema", parsed.reasons);
    if (isAbstain(parsed.value)) return stopped("needs_human", "proposal", [parsed.value.abstain]);
    const ops = parsed.value.ops;
    const matrix = checkOpsForFinding(finding, ops);
    if (!matrix.ok) return stopped("rejected", "matrix", matrix.reasons);
    const values = checkProposalValues(finding.rule, ops, bundle.validation);
    if (!values.ok) return stopped("rejected", "value", values.reasons);
    const resolution = resolveOps(page, finding, ops);
    if (!resolution.ok) return stop(resolution.state === "rejected" ? "rejected" : "needs_human", "resolve", resolution.reasons);
    const resolved = resolution.resolved;
    const applied = applyResolved(page, resolved);
    if (!applied.ok) return stop("rejected", "resolve", [applied.reason]);
    const invariants = checkInvariants(page, resolved, applied);
    let after: AuditResult; let rendered: string;
    try { rendered = input.render(applied.text, applied.insertedTitleStart); after = await engine.audit(rendered); }
    catch { return { ...stop("inconclusive", "audit", ["after_audit_error"]), ops, resolved, applied, invariants }; }
    const gateInput = { baseline, after, target: finding, invariants, changedNames: changedNameOrdinals([resolved]) };
    const codeGate = strictGate(gateInput); let gate = codeGate; let review: ReviewResponse | undefined;
    if (codeGate.accepted === true && bucketOf(finding.rule) === "content" && proposer.reviewAccepted !== undefined) {
      try { review = await proposer.reviewAccepted(finding, bundle.context, ops, codeGate, number); }
      catch { review = { decision: "inconclusive", reasons: ["jev_review_error"] }; }
      if (review.decision !== "pass") gate = gateResult("strict", review.decision === "reject" ? "rejected" : review.decision === "route" ? "needs_human" : "inconclusive", review.reasons, codeGate.nameCheck);
    }
    // strict never returns not_applicable; keep the state projection explicit and fail closed if it ever does.
    const state = gate.state === "not_applicable" ? "inconclusive" : gate.state;
    return { number, state, stage: "gate", reasons: gate.reasons, ops, resolved, applied, after, rendered, invariants, gate,
      ...(review === undefined ? {} : { review, codeGate }), ...(response.cache === undefined ? {} : { cache: response.cache }),
      variants: { targetOnly: targetOnlyGate(gateInput), scoreDelta: scoreDeltaGate(gateInput), regionScoped: regionScopedGate(gateInput, page) } };
  };
  for (let number = 1; number <= cap; number++) {
    const result = await attempt(number); attempts.push(result);
    if (result.state !== "rejected") break;
  }
  const firstPass = attempts[0]; const final = attempts.at(-1);
  if (firstPass === undefined || final === undefined) throw new Error("no_attempt_recorded");
  return { finding, proposer: proposer.id, mode: proposer.mode, attempts, firstPass, final };
}
