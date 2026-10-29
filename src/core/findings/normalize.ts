// Axe selectors locate a node only in the audited engine tree. Identity comes exclusively from trusted render
// markers read off that node; neither selector text nor axe's HTML excerpt is an ordinal/citation source.
import type { AuditResult, AuditStatus, ContrastData, Finding, Impact, UnmappedReason } from "../audit/types.ts";
import type { ParsedPage } from "../html/parse.ts";
import { formatFingerprint } from "./fingerprint.ts";
import { parseOrdinalMarker } from "../html/renderCopy.ts";
import { isPageLevelRule } from "../rules.ts";

export interface AxeCheckLike { readonly data?: unknown; readonly error?: unknown }
export interface AxeNodeLike {
  readonly target: readonly unknown[];
  readonly impact?: string | null;
  readonly failureSummary?: string;
  readonly any?: readonly AxeCheckLike[];
  readonly all?: readonly AxeCheckLike[];
  readonly none?: readonly AxeCheckLike[];
}
export interface AxeRuleLike {
  readonly id: string;
  readonly impact?: string | null;
  readonly nodes: readonly AxeNodeLike[];
  readonly error?: unknown;
}
export interface AxeResultsLike {
  readonly violations: readonly AxeRuleLike[];
  readonly incomplete: readonly AxeRuleLike[];
}
export interface TrustedMarkers {
  readonly ordinal: string | null;
  readonly unanchored: string | null;
}
export interface NormalizeOptions {
  readonly source: ParsedPage;
  readonly file: string;
  /** Return markers from exactly one actual audited element, or null on unresolved/ambiguous/shadow targets. */
  readonly resolveTarget: (target: readonly unknown[]) => TrustedMarkers | null;
  readonly engine: AuditResult["engine"];
  readonly axeVersion: string;
  readonly profile: string;
  readonly notMeasured: readonly string[];
  readonly status?: AuditStatus;
  readonly errors?: AuditResult["errors"];
}

function impact(value: string | null | undefined): Impact | null {
  return value === "minor" || value === "moderate" || value === "serious" || value === "critical" ? value : null;
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}
function contrast(node: AxeNodeLike): ContrastData | null {
  const checks = [...(node.any ?? []), ...(node.all ?? []), ...(node.none ?? [])];
  const data = checks.map((c) => record(c.data)).find((d) => d !== null && ("contrastRatio" in d || "fgColor" in d));
  if (data === undefined || data === null) return null;
  const str = (key: string): string | null => typeof data[key] === "string" ? data[key] as string : null;
  const ratio = data["contrastRatio"];
  return { fgColor: str("fgColor"), bgColor: str("bgColor"), contrastRatio: typeof ratio === "number" && Number.isFinite(ratio) ? ratio : null,
    expectedContrastRatio: str("expectedContrastRatio"), fontSize: str("fontSize"), fontWeight: str("fontWeight") };
}
function normalizeNode(rule: AxeRuleLike, node: AxeNodeLike, options: NormalizeOptions): Finding {
  let markers: TrustedMarkers | null = null;
  try { markers = options.resolveTarget(node.target); } catch { /* Ambiguous/unresolvable targets stay unmapped. */ }
  let ordinal: number | null = null;
  let reason: UnmappedReason = "unmapped";
  if (markers !== null && markers.ordinal === null &&
    (markers.unanchored === "implied_element" || markers.unanchored === "no_source_anchor")) reason = markers.unanchored;
  if (markers !== null && markers.unanchored === null) {
    const candidate = parseOrdinalMarker(markers.ordinal);
    // New elements (including title n) have no original source citation, so cannot acquire a source anchor.
    if (candidate !== null && options.source.elements[candidate] !== undefined) ordinal = candidate;
  }
  if (isPageLevelRule(rule.id)) {
    // Page-level findings must resolve to the source html node; never silently remap a different engine node.
    if (ordinal !== options.source.htmlOrdinal || options.source.htmlOrdinal === null) {
      ordinal = null;
      reason = options.source.htmlOrdinal === null ? options.source.htmlReason ?? "implied_element" : "unmapped";
    }
  }
  const anchor = ordinal === null ? undefined : options.source.elements[ordinal];
  return { rule: rule.id, ordinal, fingerprint: ordinal === null ? null : formatFingerprint(rule.id, ordinal),
    impact: impact(node.impact ?? rule.impact), cite: anchor === undefined ? null : { file: options.file, line: anchor.line, col: anchor.col },
    unmappedReason: ordinal === null ? reason : null, summary: node.failureSummary ?? null,
    contrast: rule.id === "color-contrast" ? contrast(node) : null };
}

/** Normal incomplete results remain findings; execution errors are a separate partial-audit status. */
export function axeExecutionErrorRules(raw: AxeResultsLike): string[] {
  return [...new Set([...raw.violations, ...raw.incomplete].filter((r) => r.error != null || r.nodes.some((n) =>
    [...(n.any ?? []), ...(n.all ?? []), ...(n.none ?? [])].some((c) => c.error != null || record(c.data)?.["error"] != null))).map((r) => r.id))];
}
export function hasAxeExecutionErrors(raw: AxeResultsLike): boolean {
  return axeExecutionErrorRules(raw).length > 0;
}

export function normalizeAudit(raw: AxeResultsLike, options: NormalizeOptions): AuditResult {
  const failedRules = axeExecutionErrorRules(raw);
  const partial = failedRules.length > 0;
  return { status: options.status ?? (partial ? "partial" : "complete"),
    findings: raw.violations.flatMap((r) => r.nodes.map((n) => normalizeNode(r, n, options))),
    incomplete: raw.incomplete.flatMap((r) => r.nodes.map((n) => normalizeNode(r, n, options))),
    engine: options.engine, axeVersion: options.axeVersion, profile: options.profile, notMeasured: [...options.notMeasured],
    errors: [...(options.errors ?? []), ...failedRules.map((rule) => ({ code: `axe_check_error:${rule}`, message: "An axe check did not complete." }))] };
}
