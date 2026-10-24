// Local pinned cache only. Importing or evaluating ACT never invokes the downloader.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "../shared/deps.ts";
import { ELIGIBLE_RULE_IDS } from "../shared/rules.ts";
import type { AuditResult, Finding } from "../core/audit/types.ts";
import { validateActUrl } from "./act.ts";
const CaseSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), file: z.string(), finalUrl: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), actRuleId: z.string(), axeRule: z.enum(ELIGIBLE_RULE_IDS), expectation: z.enum(["passed", "failed"]) }).strict();
export const ActCacheManifestSchema = z.object({ schemaVersion: z.literal(1), cases: z.array(CaseSchema).min(1).max(50) }).strict();
export async function loadActCache(directory: string) {
  const manifest = ActCacheManifestSchema.parse(JSON.parse(await readFile(join(directory, "MANIFEST.json"), "utf8")) as unknown);
  if (new Set(manifest.cases.map((item) => item.id)).size !== manifest.cases.length) throw new Error("duplicate_act_case");
  return Promise.all(manifest.cases.map(async (meta) => {
    if (meta.file !== `${meta.id}.html`) throw new Error("invalid_act_cache_path"); validateActUrl(meta.finalUrl);
    const bytes = await readFile(join(directory, meta.file)); if (bytes.length > 200000 || createHash("sha256").update(bytes).digest("hex") !== meta.sha256) throw new Error("act_cache_pin_or_size_mismatch");
    return { meta, source: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  }));
}
/** Passed cases get no proposal even if a mapping mismatch finds a violation. Only reproduced violations qualify. */
export function actTargets(expectation: "passed" | "failed", rule: string, baseline: AuditResult | null, stable: boolean): Finding[] {
  if (expectation === "passed" || !stable || baseline === null || baseline.status !== "complete" || baseline.notMeasured.includes(rule)) return [];
  const seen = new Set<string>();
  return baseline.findings.filter((finding) => finding.rule === rule && finding.ordinal !== null && finding.fingerprint !== null && !seen.has(finding.fingerprint) && Boolean(seen.add(finding.fingerprint)))
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
}
export const ActCaseRecordSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("act_case"), id: z.string(), actRuleId: z.string(), axeRule: z.enum(ELIGIBLE_RULE_IDS), expectation: z.enum(["passed", "failed"]),
  stable: z.boolean(), baselineStatus: z.enum(["complete", "partial", "error", "timeout"]).nullable(), mappedViolations: z.number().int().nonnegative().nullable(),
  eligibleTargets: z.number().int().nonnegative().nullable(), proposedTargets: z.number().int().nonnegative(), sourceSha256: z.string(), engineProfile: z.string().nullable(), reasons: z.array(z.string()) }).strict().superRefine((record, ctx) => {
    if (record.expectation === "passed" && record.proposedTargets !== 0) ctx.addIssue({ code: "custom", message: "act_passed_case_proposed" });
  });
export type ActCaseRecord = z.infer<typeof ActCaseRecordSchema>;
