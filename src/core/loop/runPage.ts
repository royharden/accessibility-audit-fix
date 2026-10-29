import type { AuditEngine, AuditResult, Finding } from "../audit/types.ts";
import type { ParsedPage } from "../html/parse.ts";
import { parsePage } from "../html/parse.ts";
import { buildRenderCopy } from "../html/renderCopy.ts";
import type { FixProposer } from "../proposers/types.ts";
import type { FixResult, FixState } from "../ledger/types.ts";
import { MAX_INPUT_BYTES, MAX_PROPOSAL_QUEUE, utf8ByteLength } from "../limits.ts";
import { isEligibleRule } from "../rules.ts";
import { runFix } from "./runFix.ts";

export interface FindingItem { readonly finding: Finding; readonly state: FixState | "not_attempted"; readonly reasons: readonly string[]; readonly fix?: FixResult }
export interface Artifact {
  readonly source: string; readonly file: string; readonly mode: "mock" | "live"; readonly page: ParsedPage;
  readonly baseline: AuditResult; readonly baselineRender: string; readonly items: readonly FindingItem[]; readonly fixes: readonly FixResult[];
  readonly queue: { readonly eligibleCount: number; readonly attemptedCount: number; readonly truncatedCount: number; readonly flag: string | null };
  readonly engine: AuditEngine; readonly render: (source: string, insertedTitleStart: number | null) => string;
}
export interface RunPageInput {
  readonly source: string; readonly file?: string; readonly proposer: FixProposer;
  readonly createEngine: (originalPage: ParsedPage) => AuditEngine;
  readonly render?: (source: string, insertedTitleStart: number | null) => string; readonly maxAttempts?: number;
}
export type RunPageResult = { readonly status: "audited"; readonly artifact: Artifact } |
  { readonly status: "input_rejected" | "inconclusive"; readonly reasons: readonly string[]; readonly inputBytes: number };
export async function runPage(input: RunPageInput): Promise<RunPageResult> {
  const inputBytes = utf8ByteLength(input.source);
  if (inputBytes > MAX_INPUT_BYTES) return { status: "input_rejected", reasons: ["input_too_large"], inputBytes };
  const file = input.file ?? "page.html";
  const render = input.render ?? ((source: string, insertedTitleStart: number | null) => buildRenderCopy(source, { insertedTitleStart }).html);
  let page: ParsedPage; let engine: AuditEngine; let baseline: AuditResult; let baselineRender: string;
  try { page = parsePage(input.source); engine = input.createEngine(page); baselineRender = render(input.source, null); baseline = await engine.audit(baselineRender); }
  catch { return { status: "inconclusive", reasons: ["baseline_audit_error"], inputBytes }; }
  if (baseline.status !== "complete" || baseline.errors.length > 0) return { status: "inconclusive",
    reasons: [`baseline_${baseline.status}`, ...baseline.errors.map((error) => error.code)], inputBytes };
  // Keep the full audit unchanged. Deduplication is only for the proposal queue (violation preferred).
  const unique: Finding[] = [];
  const seen = new Set<string>();
  for (const finding of [...baseline.findings, ...baseline.incomplete]) {
    const key = finding.fingerprint;
    if (key !== null) { if (seen.has(key)) continue; seen.add(key); }
    unique.push(finding);
  }
  const eligible = unique.filter((f) => isEligibleRule(f.rule) && f.ordinal !== null && f.fingerprint !== null && !baseline.notMeasured.includes(f.rule))
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
  const queue = eligible.slice(0, MAX_PROPOSAL_QUEUE);
  const scheduled = new Set(queue);
  const fixes: FixResult[] = [];
  const byFinding = new Map<Finding, FixResult>();
  if (baseline.status === "complete" && baseline.errors.length === 0) for (const finding of queue) {
    const fix = await runFix({ page, engine, baseline, finding, proposer: input.proposer, render, file, maxAttempts: input.maxAttempts });
    fixes.push(fix); byFinding.set(finding, fix);
  }
  const items: FindingItem[] = unique.map((finding) => {
    const fix = byFinding.get(finding);
    if (fix !== undefined) return { finding, state: fix.final.state, reasons: fix.final.reasons, fix };
    if (!isEligibleRule(finding.rule)) return { finding, state: "not_attempted", reasons: ["rule_not_eligible"] };
    if (baseline.status !== "complete" || baseline.errors.length > 0) return { finding, state: "inconclusive", reasons: ["baseline_not_complete"] };
    if (finding.ordinal === null || finding.fingerprint === null) return { finding, state: "needs_human", reasons: [finding.unmappedReason ?? "unmapped"] };
    if (baseline.notMeasured.includes(finding.rule)) return { finding, state: "not_attempted", reasons: ["target_not_measured"] };
    return { finding, state: "not_attempted", reasons: [scheduled.has(finding) ? "not_attempted" : "proposal_queue_truncated"] };
  });
  const truncatedCount = Math.max(0, eligible.length - MAX_PROPOSAL_QUEUE);
  return { status: "audited", artifact: { source: input.source, file, mode: input.proposer.mode, page, baseline, baselineRender, items, fixes,
    queue: { eligibleCount: eligible.length, attemptedCount: fixes.length, truncatedCount, flag: truncatedCount > 0 ? "proposal_queue_truncated" : null }, engine, render } };
}
