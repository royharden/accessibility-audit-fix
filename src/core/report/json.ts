import type { AuditResult } from "../audit/types.ts";
import type { FixAttempt } from "../ledger/types.ts";
import type { Artifact } from "../loop/runPage.ts";
import type { CombineResult } from "../gate/combine.ts";
import { utf8ByteLength } from "../limits.ts";

export interface ReportOptions {
  readonly sha256: (text: string) => Promise<string>;
  /** Exact bytes/text of the frozen engine-profile.json file, not a reconstructed object. */
  readonly engineProfileText: string;
  readonly combined?: CombineResult;
}
function summary(audit: AuditResult) {
  return { status: audit.status, violations: audit.findings.length, incomplete: audit.incomplete.length,
    unmapped: [...audit.findings, ...audit.incomplete].filter((f) => f.ordinal === null).length, notMeasured: audit.notMeasured, errors: audit.errors };
}
async function attemptRecord(attempt: FixAttempt, hash: ReportOptions["sha256"]) {
  return { number: attempt.number, state: attempt.state, stage: attempt.stage, reasons: attempt.reasons,
    ops: attempt.ops ?? null, opsSha256: attempt.ops === undefined ? null : await hash(JSON.stringify(attempt.ops)),
    sourceSha256: attempt.applied === undefined ? null : await hash(attempt.applied.text),
    renderSha256: attempt.rendered === undefined ? null : await hash(attempt.rendered),
    gate: attempt.gate ?? null, codeGate: attempt.codeGate ?? null, review: attempt.review ?? null, cache: attempt.cache ?? null, variants: attempt.variants ?? null,
    invariants: attempt.invariants === undefined ? null : { ok: attempt.invariants.ok, reasons: attempt.invariants.reasons },
    audit: attempt.after === undefined ? null : { ...summary(attempt.after), findings: attempt.after.findings, incomplete: attempt.after.incomplete } };
}
/** Data contains no invented measurements: absent audits/hashes stay null, and the mode is explicit. */
export async function buildJsonReport(artifact: Artifact, options: ReportOptions) {
  const hash = options.sha256;
  const fixes = await Promise.all(artifact.fixes.map(async (fix) => {
    const attempts = await Promise.all(fix.attempts.map((attempt) => attemptRecord(attempt, hash)));
    return { fingerprint: fix.finding.fingerprint, rule: fix.finding.rule, cite: fix.finding.cite, proposer: fix.proposer, mode: fix.mode,
      firstPass: attempts[0] ?? null, final: attempts.at(-1) ?? null, attempts };
  }));
  const combined = options.combined;
  return { schemaVersion: 1, mode: artifact.mode, file: artifact.file,
    engine: artifact.baseline.engine, axeVersion: artifact.baseline.axeVersion, engineProfile: artifact.baseline.profile,
    sourceSha256: await hash(artifact.source), renderSha256: await hash(artifact.baselineRender),
    engineProfileSha256: await hash(options.engineProfileText), inputBytes: utf8ByteLength(artifact.source), queue: artifact.queue,
    baseline: { ...summary(artifact.baseline), findings: artifact.baseline.findings, incomplete: artifact.baseline.incomplete },
    findings: artifact.items.map((item) => ({ ...item.finding, state: item.state, reasons: item.reasons })), fixes,
    export: combined === undefined ? { state: "not_requested" } : combined.state === "blocked" ? {
      state: "blocked", reasons: combined.reasons, conflicts: combined.conflicts, diagnostics: combined.diagnostics,
    } : { state: "ready", includedIds: combined.includedIds, sourceSha256: await hash(combined.text),
      renderSha256: await hash(combined.rendered),
      summary: summary(combined.after), findings: combined.after.findings, incomplete: combined.after.incomplete } };
}
