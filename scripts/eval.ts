// Activation eval: offline by default; llm-A uses only the authenticated, server-budgeted edge route.
// Never generates/fetches fixtures or provisions a database. No provider keys or password files/env are read.
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { GoldPageSchema } from "../gold/oracle/schema.ts";
import { ManifestSchema } from "../fixtures/manifestSchema.ts";
import type { RuleId } from "../src/shared/rules.ts";
import { bucketOf, ELIGIBLE_RULE_IDS } from "../src/shared/rules.ts";
import { parsePage } from "../src/core/html/parse.ts";
import { buildRenderCopy } from "../src/core/html/renderCopy.ts";
import { formatFingerprint } from "../src/core/findings/fingerprint.ts";
import { MAX_INPUT_BYTES, utf8ByteLength } from "../src/core/limits.ts";
import type { Finding } from "../src/core/audit/types.ts";
import type { FixAttempt, FixResult } from "../src/core/ledger/types.ts";
import { runFix } from "../src/core/loop/runFix.ts";
import { rulesProposer } from "../src/core/proposers/rules.ts";
import { createMockProposer, parseReplayScript } from "../src/core/proposers/mock.ts";
import { createJsdomEngine } from "../src/node/jsdomEngine.ts";
import { auditBaselineTwice } from "../src/node/baseline.ts";
import { judgeGoldDefect } from "../src/node/oracle.ts";
import type { ResultRow } from "../src/node/resultsSchema.ts";
import { ResultRowSchema, parseResultsJsonl, resultsMarkdown, failuresMarkdown } from "../src/node/resultsSchema.ts";
import { openOperatorSession } from "../src/node/operatorSession.ts";
import type { OperatorSession } from "../src/node/operatorSession.ts";
import { EvalCheckpoint, createCheckpointTransport, deterministicAttemptId } from "../src/node/evalCheckpoint.ts";
import { FsLedger } from "../src/node/fsLedger.ts";
import { createRemoteProposer } from "../src/core/proposers/remote.ts";
import { METHODS } from "../src/shared/providerConfig.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
function repoFile(path: string): string {
  const full = resolve(root, path); const rel = relative(root, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || resolve(full) === resolve(root)) throw new Error("eval_path_outside_repo");
  return full;
}
async function inputHtml(path: string): Promise<string> {
  const bytes = await readFile(repoFile(path)); if (bytes.length > MAX_INPUT_BYTES) throw new Error("input_too_large");
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (utf8ByteLength(source) > MAX_INPUT_BYTES) throw new Error("input_too_large"); return source;
}
function blank(table: ResultRow["table"], pageId: string, family: string, rule: RuleId, ordinal: number | null, proposer: string, source: string): ResultRow {
  return { schemaVersion: 1, kind: "defect", table, pageId, family, rule, ordinal, fingerprint: ordinal === null ? null : formatFingerprint(rule, ordinal), bucket: bucketOf(rule),
    proposer, mode: proposer === "rules" || proposer === "mock" ? "mock" : "live", measurement: "not_measured", sourceSha256: hash(source), renderSha256: null,
    engineProfileSha256: null, engineProfile: null, axeVersion: null, engine: null, baselineDetected: null, baselineStable: null, eligible: false,
    beforeProposalHuman: false, inconclusive: false, firstPass: { state: "not_measured", stage: null, reasons: ["proposer_not_wired"], oracleCorrect: null, gates: null },
    afterRetry: { state: "not_measured", reasons: ["proposer_not_wired"], oracleCorrect: null, strict: null, attempts: 0 }, costUsdMicros: null, humanApproved: null };
}
function applyFix(row: ResultRow, fix: FixResult, oracle: (attempt: FixAttempt) => boolean | null): ResultRow {
  const first = fix.firstPass; const final = fix.final;
  return ResultRowSchema.parse({ ...row, beforeProposalHuman: first.stage === "context" && first.state === "needs_human", inconclusive: final.state === "inconclusive",
    firstPass: { state: first.state, stage: first.stage, reasons: first.reasons.slice(), oracleCorrect: oracle(first),
      gates: first.gate === undefined || first.variants === undefined ? null : { strict: first.gate, "target-only": first.variants.targetOnly, "score-delta": first.variants.scoreDelta, "region-scoped": first.variants.regionScoped } },
    afterRetry: { state: final.state, reasons: final.reasons.slice(), oracleCorrect: oracle(final), strict: final.gate ?? null, attempts: fix.attempts.length } });
}
async function evaluatePage<D extends { rule: RuleId; ordinal: number | null }>(source: string, file: string, rows: ResultRow[], defects: readonly D[],
  makeRow: (defect: D) => ResultRow, proposer: typeof rulesProposer,
  judge: (defect: D, attempt: FixAttempt) => boolean | null, profileText: string,
  hooks: { shouldStop?: () => boolean; costFor?: (fix: FixResult) => number | null } = {}): Promise<void> {
  const page = parsePage(source); const engine = createJsdomEngine({ source: page, file });
  const render = (text: string, insertedTitleStart: number | null) => buildRenderCopy(text, { insertedTitleStart }).html;
  const rendered = render(source, null); const stability = await auditBaselineTwice(engine, rendered);
  for (const defect of defects) {
    if (hooks.shouldStop?.() === true) {
      const row = makeRow(defect); row.firstPass.reasons = ["run_stopped_budget_exceeded"]; row.afterRetry.reasons = ["run_stopped_budget_exceeded"];
      rows.push(ResultRowSchema.parse(row)); continue;
    }
    const baseline = stability.first;
    let row: ResultRow = { ...makeRow(defect), measurement: "measured", baselineStable: stability.stable,
      renderSha256: hash(rendered), engineProfileSha256: hash(profileText), engine: baseline?.engine ?? null, engineProfile: baseline?.profile ?? null, axeVersion: baseline?.axeVersion ?? null };
    if (!stability.stable || baseline === null) {
      row = { ...row, inconclusive: true, baselineDetected: null, firstPass: { state: "inconclusive", stage: "audit", reasons: [...stability.reasons], oracleCorrect: null, gates: null },
        afterRetry: { state: "inconclusive", reasons: [...stability.reasons], oracleCorrect: null, strict: null, attempts: 0 } };
    } else {
      const target: Finding | undefined = [...baseline.findings, ...baseline.incomplete].find((finding) => finding.rule === defect.rule && finding.ordinal === defect.ordinal);
      const detected = target !== undefined && !baseline.notMeasured.includes(defect.rule);
      row = { ...row, baselineDetected: detected, eligible: detected, firstPass: { ...row.firstPass, state: baseline.notMeasured.includes(defect.rule) ? "not_measured" : "not_attempted", reasons: [baseline.notMeasured.includes(defect.rule) ? "target_not_measured" : "baseline_did_not_detect_target"] },
        afterRetry: { ...row.afterRetry, state: baseline.notMeasured.includes(defect.rule) ? "not_measured" : "not_attempted", reasons: [baseline.notMeasured.includes(defect.rule) ? "target_not_measured" : "baseline_did_not_detect_target"] } };
      if (detected && target !== undefined) {
        const fix = await runFix({ page, finding: target, baseline, engine, proposer, render, file });
        row = applyFix(row, fix, (attempt) => judge(defect, attempt));
        if (hooks.costFor !== undefined) row.costUsdMicros = hooks.costFor(fix);
      }
    }
    rows.push(ResultRowSchema.parse(row));
  }
}
async function main(): Promise<void> {
  const option = process.argv.indexOf("--proposers"); const selected = (option < 0 ? "rules,mock" : process.argv[option + 1] ?? "").split(",").filter(Boolean);
  if (selected.length === 0 || new Set(selected).size !== selected.length || selected.some((id) => !["rules", "mock", "llm-A", "llm-B", "jev"].includes(id))) throw new Error("invalid_proposer_allowlist");
  const rows: ResultRow[] = []; const profileText = await readFile(repoFile("engine-profile.json"), "utf8");
  let operator: OperatorSession | null = null;
  let live: { session: OperatorSession; transport: ReturnType<typeof createCheckpointTransport>; ledger: FsLedger; runKey: string } | null = null;
  if (selected.includes("llm-A")) {
    const index = process.argv.indexOf("--run-key"); const runKey = index < 0 ? undefined : process.argv[index + 1];
    if (runKey === undefined || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(runKey)) throw new Error("llm-A requires --run-key <owner-precreated-eval-budget-key>");
    operator = await openOperatorSession();
    const checkpoint = new EvalCheckpoint(repoFile(`results/eval-checkpoint-${runKey}.jsonl`)); const ledger = new FsLedger(repoFile("results/callledger.jsonl"));
    try { await checkpoint.load(); await ledger.load(); } catch (error) { await operator.close(); throw error; }
    live = { session: operator, transport: createCheckpointTransport({ session: operator, checkpoint, ledger }), ledger, runKey };
  }
  try {
  if (selected.some((id) => id !== "mock")) {
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(repoFile("fixtures/MANIFEST.json"), "utf8")) as unknown);
    if (["id", "file", "oracleFile"].some((key) => new Set(manifest.pages.map((page) => page[key as "id" | "file" | "oracleFile"])).size !== 40)) throw new Error("duplicate_fixture_identity");
    if (manifest.pages.filter((page) => page.split === "heldout").length !== 20 || manifest.pages.filter((page) => page.split === "dev").length !== 20) throw new Error("fixture_split_mismatch");
    const devFamilies = new Set(manifest.pages.filter((page) => page.split === "dev").map((page) => page.family));
    if (manifest.pages.some((page) => page.split === "heldout" && devFamilies.has(page.family))) throw new Error("fixture_family_leakage");
    for (const item of manifest.pages.filter((page) => page.split === "heldout")) {
      if (!/^fixtures\/pages\/[a-z0-9-]+\.html$/.test(item.file) || !/^gold\/oracle\/[a-z0-9-]+\.json$/.test(item.oracleFile)) throw new Error("unexpected_fixture_path");
      const source = await inputHtml(item.file); const gold = GoldPageSchema.parse(JSON.parse(await readFile(repoFile(item.oracleFile), "utf8")) as unknown);
      if (hash(source) !== item.sha256 || gold.sourceSha256 !== item.sha256 || gold.pageId !== item.id || gold.file !== item.file || gold.family !== item.family || gold.split !== item.split || gold.defects.length !== item.defectCount ||
        new Set(gold.defects.map((defect) => `${defect.rule}:${defect.ordinal}`)).size !== gold.defects.length) throw new Error("fixture_oracle_manifest_mismatch");
      for (const proposer of selected.filter((id) => id !== "mock")) {
        const make = (defect: { rule: RuleId; ordinal: number | null }) => blank("heldout", item.id, item.family, defect.rule, defect.ordinal, proposer, source);
        if (proposer !== "rules" && proposer !== "llm-A") { rows.push(...gold.defects.map((defect) => ResultRowSchema.parse(make(defect)))); continue; }
        const original = parsePage(source);
        if (proposer === "llm-A" && live !== null) {
          const connection = live;
          if (connection.transport.isStopped()) {
            rows.push(...gold.defects.map((defect) => { const row = make(defect); row.firstPass.reasons = ["run_stopped_budget_exceeded"]; row.afterRetry.reasons = ["run_stopped_budget_exceeded"]; return ResultRowSchema.parse(row); })); continue;
          }
          const ids = new Map<string, string[]>();
          const profile = JSON.parse(profileText) as { engines: { jsdom: { profileId: string } } };
          const remote = createRemoteProposer({ proposer: "llm-A", runKey: connection.runKey, invoke: connection.transport.invoke,
            async attemptId(finding, attempt) {
              const id = await deterministicAttemptId({ uid: connection.session.userId, runKey: connection.runKey, sourceSha256: hash(source),
                engineProfile: `${profile.engines.jsdom.profileId}:${hash(profileText)}`, fingerprint: finding.fingerprint ?? "unmapped", proposer: "llm-A", model: METHODS["llm-A"].model, attempt });
              ids.set(finding.fingerprint ?? "unmapped", [...(ids.get(finding.fingerprint ?? "unmapped") ?? []), id]); return id;
            } });
          await evaluatePage(source, item.file, rows, gold.defects, make, remote,
            (defect, attempt) => judgeGoldDefect(original, defect, attempt).correct, profileText,
            { shouldStop: connection.transport.isStopped, costFor: (fix) => connection.ledger.costFor(ids.get(fix.finding.fingerprint ?? "unmapped") ?? []) });
        } else await evaluatePage(source, item.file, rows, gold.defects, make, rulesProposer,
          (defect, attempt) => judgeGoldDefect(original, defect, attempt).correct, profileText);
      }
    }
  }
  if (selected.includes("mock")) for (const dir of (await readdir(repoFile("fixtures/traps"), { withFileTypes: true })).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const base = `fixtures/traps/${dir.name}`; const source = await inputHtml(`${base}/page.html`);
    const script = parseReplayScript(JSON.parse(await readFile(repoFile(`${base}/proposal.json`), "utf8")) as unknown);
    const expected = JSON.parse(await readFile(repoFile(`${base}/expected.json`), "utf8")) as { target: { rule: RuleId; ordinal: number | null }; oracle: { correct: boolean } };
    if (!ELIGIBLE_RULE_IDS.includes(expected.target.rule) || typeof expected.oracle.correct !== "boolean") throw new Error("invalid_trap_expectation");
    await evaluatePage(source, `${base}/page.html`, rows, [expected.target],
      (defect) => blank("traps", dir.name, "scripted-trap", defect.rule, defect.ordinal, "mock", source), createMockProposer([script]),
      (_defect, attempt) => script.attempts[Math.min(attempt.number - 1, script.attempts.length - 1)]?.kind === "ops" ? expected.oracle.correct : null, profileText);
  }
  const output = repoFile("results"); await mkdir(output, { recursive: true });
  await writeFile(repoFile("results/results.jsonl"), rows.map((row) => JSON.stringify(ResultRowSchema.parse(row))).join("\n") + "\n", "utf8");
  // All report/failure numbers derive from the persisted ledger, never live objects or hand-written counters.
  const saved = parseResultsJsonl(await readFile(repoFile("results/results.jsonl"), "utf8"));
  await writeFile(repoFile("results/results.md"), resultsMarkdown(saved), "utf8");
  await writeFile(repoFile("results/failures.md"), failuresMarkdown(saved), "utf8");
  console.log(`Saved ${saved.length} result rows. ACT/llm-B/Jev remain not measured until M8. Live llm-A uses only the server eval_run budget route; unavailable cost remains null.${live?.transport.isStopped() === true ? " Paid run stopped: budget_exceeded; remaining rows are explicitly not measured." : ""}`);
  } finally { await operator?.close(); }
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "eval_failed"); process.exitCode = 1; });
