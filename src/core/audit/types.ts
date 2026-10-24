// Audit contracts (PLAN.md 2.4-2.5, CL 2.6-2.7). Both engines (jsdom in Node, sandboxed iframe in the browser)
// return an AuditResult; results from different engines or render profiles are never compared.
// A result with status !== "complete" makes an attempt `inconclusive`; it is never read as "no findings".
import type { EngineId } from "../rules.ts";
import type { Fingerprint } from "../findings/fingerprint.ts";

export const AUDIT_STATUSES = ["complete", "error", "timeout", "partial"] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export type Impact = "minor" | "moderate" | "serious" | "critical";

/** `file:line:col`, 1-based, BOM-adjusted (`cited`). */
export interface Cite {
  readonly file: string;
  readonly line: number;
  readonly col: number;
}

/**
 * Why a finding has no ordinal: `implied_element` (html/head/body absent from the source text),
 * `no_source_anchor` (parse-recovery clone), `unmapped` (axe node without a single trusted data-a11y-ord marker).
 * Such findings go to `needs_human` with this reason.
 */
export const UNMAPPED_REASONS = ["implied_element", "no_source_anchor", "unmapped"] as const;
export type UnmappedReason = (typeof UNMAPPED_REASONS)[number];

/** axe colour data for color-contrast findings (proposer context, review M5). */
export interface ContrastData {
  readonly fgColor: string | null;
  readonly bgColor: string | null;
  readonly contrastRatio: number | null;
  readonly expectedContrastRatio: string | null;
  readonly fontSize: string | null;
  readonly fontWeight: string | null;
}

/**
 * One axe node result, normalised (M3 `findings/normalize.ts`). `rule` is any audited axe rule id, not only an
 * eligible one. Invariant: `ordinal === null` iff `fingerprint === null` iff `unmappedReason !== null`.
 */
export interface Finding {
  readonly rule: string;
  readonly ordinal: number | null;
  readonly fingerprint: Fingerprint | null;
  readonly impact: Impact | null;
  readonly cite: Cite | null;
  readonly unmappedReason: UnmappedReason | null;
  /** axe failureSummary (bounded by the context builder before it reaches a proposer). */
  readonly summary: string | null;
  readonly contrast: ContrastData | null;
}

export interface AuditError {
  readonly code: string;
  readonly message: string;
}

export interface AuditResult {
  readonly status: AuditStatus;
  /** axe violations. */
  readonly findings: readonly Finding[];
  /** axe incomplete ("needs review"); kept and gated like violations. */
  readonly incomplete: readonly Finding[];
  readonly engine: EngineId;
  /** Pinned axe-core version actually loaded. */
  readonly axeVersion: string;
  /** engine-profile id (engine-profile.json). */
  readonly profile: string;
  /** Rules listed "not measured" by the profile (e.g. color-contrast and label-content-name-mismatch under jsdom). */
  readonly notMeasured: readonly string[];
  readonly errors: readonly AuditError[];
}

/** Implemented in M3 (src/node/jsdomEngine.ts) and M7 (src/engines/iframe). */
export interface AuditEngine {
  readonly id: EngineId;
  audit(renderCopy: string): Promise<AuditResult>;
}

export function isConclusive(result: AuditResult): boolean {
  return result.status === "complete";
}

export function isAnchored(finding: Finding): finding is Finding & { readonly ordinal: number; readonly fingerprint: Fingerprint } {
  return finding.ordinal !== null && finding.fingerprint !== null;
}
