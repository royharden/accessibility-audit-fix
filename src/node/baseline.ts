import type { AuditEngine, AuditResult, Finding } from "../core/audit/types.ts";
function signatures(findings: readonly Finding[]): string {
  const anchored = [...new Set(findings.flatMap((f) => f.fingerprint === null ? [] : [f.fingerprint]))].sort();
  const unmapped = new Map<string, number>();
  for (const f of findings) if (f.fingerprint === null) { const key = `${f.rule}:${f.unmappedReason ?? "unmapped"}`; unmapped.set(key, (unmapped.get(key) ?? 0) + 1); }
  return JSON.stringify({ anchored, unmapped: [...unmapped].sort(([a], [b]) => a.localeCompare(b)) });
}
export function baselinesMatch(a: AuditResult, b: AuditResult): boolean {
  return a.status === "complete" && b.status === "complete" && a.errors.length === 0 && b.errors.length === 0 &&
    a.engine === b.engine && a.profile === b.profile && a.axeVersion === b.axeVersion &&
    JSON.stringify([...a.notMeasured].sort()) === JSON.stringify([...b.notMeasured].sort()) &&
    signatures(a.findings) === signatures(b.findings) && signatures(a.incomplete) === signatures(b.incomplete);
}
export async function auditBaselineTwice(engine: AuditEngine, render: string): Promise<{
  stable: boolean; first: AuditResult | null; second: AuditResult | null; reasons: readonly string[];
}> {
  let first: AuditResult | null = null; let second: AuditResult | null = null;
  try { first = await engine.audit(render); second = await engine.audit(render); }
  catch { return { stable: false, first, second, reasons: ["baseline_audit_error"] }; }
  const stable = baselinesMatch(first, second);
  return { stable, first, second, reasons: stable ? [] : ["baseline_not_deterministic_or_incomplete"] };
}
