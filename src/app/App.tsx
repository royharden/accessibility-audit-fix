import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { createTwoFilesPatch } from "diff";
import { MAX_INPUT_BYTES, utf8ByteLength } from "../core/limits.ts";
import { runPage } from "../core/loop/runPage.ts";
import type { Artifact } from "../core/loop/runPage.ts";
import { rulesProposer } from "../core/proposers/rules.ts";
import type { FixProposer } from "../core/proposers/types.ts";
import { combineFixes, latestRulingFor } from "../core/gate/combine.ts";
import type { CombineFix, CombineResult, Ruling, RulingKey } from "../core/gate/combine.ts";
import { buildJsonReport } from "../core/report/json.ts";
import { combinedPatch } from "../core/report/patch.ts";
import { sha256Text } from "../shared/requestHash.ts";
import { createIframeEngine } from "../engines/iframe/host.ts";
import { backend } from "./lib/supabase.ts";
import { createDatabaseRulingsStore, createMemoryRulingsStore } from "./lib/rulingsStore.ts";
import type { RulingsStore } from "./lib/rulingsStore.ts";
import { beginDecision, emptyDecisionState, pendingDecision, reconcileDecisions, resetDecisionPage, rulingsForExport, selectDecisionPage } from "./lib/decisionState.ts";
import type { DecisionState } from "./lib/decisionState.ts";
import { createBrowserProposer } from "./lib/proposeClient.ts";
import { SAMPLE_HTML, sampleMockProposer } from "./sample.ts";
import engineProfileText from "../../engine-profile.json?raw";
import jevPolicy from "../../config/jev-thresholds.json" with { type: "json" };
import { JevPolicySchema, canUseJev } from "../shared/typesafePlan.ts";

type Mode = "rules" | "mock" | "llm-A" | "llm-B" | "jev";
const words = (value: string): string => value.replaceAll("_", " ");
const problemText = (error: unknown): string => error instanceof Error ? error.message.slice(0, 300) : "Operation failed. Please try again.";
const RECONCILE_DECISIONS = "Saved decisions are unconfirmed. Export is blocked. Reload saved decisions or retry the pending decision; your current audit will be kept.";
function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function App() {
  const [source, setSource] = useState(SAMPLE_HTML);
  const [file, setFile] = useState("storefront.html");
  const [mode, setMode] = useState<Mode>("mock");
  const [consent, setConsent] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [memoryStore, setMemoryStore] = useState<RulingsStore>(() => createMemoryRulingsStore());
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [decisions, setDecisions] = useState<DecisionState>(() => emptyDecisionState());
  const [keys, setKeys] = useState<Readonly<Record<string, RulingKey>>>({});
  const [combined, setCombined] = useState<CombineResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engine = useRef<ReturnType<typeof createIframeEngine> | null>(null);
  const generation = useRef(0);
  const identity = useRef<string | null>(null);
  const decisionsRef = useRef(decisions);
  const preparedDecisions = useRef<DecisionState | null>(null);
  const rulingBusy = useRef(false);
  const publishDecisions = useCallback((next: DecisionState): void => {
    decisionsRef.current = next; preparedDecisions.current = null; setCombined(null); setDecisions(next);
  }, []);
  const userId = user?.id ?? null;
  const store = useMemo(() => backend.client !== null && userId !== null
    ? createDatabaseRulingsStore(backend.client, userId) : memoryStore, [userId, memoryStore]);

  const resetRun = useCallback((identityChanged = false) => {
    generation.current++; engine.current?.close(); engine.current = null;
    rulingBusy.current = false;
    publishDecisions(identityChanged ? emptyDecisionState() : resetDecisionPage(decisionsRef.current));
    setArtifact(null); setKeys({}); setCombined(null); setSelected(0); setBusy(false); setError(null);
  }, [publishDecisions]);
  useEffect(() => {
    const client = backend.client;
    if (client === null) return () => { engine.current?.close(); };
    let active = true;
    const acceptUser = (next: User | null): void => {
      if (!active) return;
      const id = next?.id ?? null;
      if (identity.current !== id) {
        identity.current = id; resetRun(true); setMemoryStore(createMemoryRulingsStore());
      }
      setUser(next);
    };
    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError !== null) setError("Could not restore the live session. Demo mode is available.");
      acceptUser(data.session?.user ?? null);
    }).catch(() => { if (active) setError("Could not restore the live session. Demo mode is available."); });
    const subscription = client.auth.onAuthStateChange((_event, session) => acceptUser(session?.user ?? null));
    return () => { active = false; subscription.data.subscription.unsubscribe(); engine.current?.close(); };
  }, [resetRun]);

  const inputBytes = utf8ByteLength(source);
  const live = mode === "llm-A" || mode === "llm-B" || mode === "jev";
  const rulings = decisions.rulings;
  const pending = pendingDecision(decisions);
  const downloadsReady = decisions.trusted && preparedDecisions.current === decisions && combined?.state === "ready";
  const chosen = artifact?.items[selected];
  const fix = chosen?.fix;
  const final = fix?.final;
  const selectedKey = chosen?.finding.fingerprint === null || chosen?.finding.fingerprint === undefined
    ? undefined : keys[chosen.finding.fingerprint];
  const decision = selectedKey === undefined || !decisions.trusted ? null : latestRulingFor(selectedKey, rulings);
  const accepted = final?.gate?.accepted === true && final.resolved !== undefined;
  const acceptedCount = artifact?.items.filter((item) => item.state === "verified" || item.state === "checked").length ?? 0;
  const approvedCount = decisions.trusted ? (artifact?.fixes.filter((item) => {
    const key = item.finding.fingerprint === null ? undefined : keys[item.finding.fingerprint];
    return key !== undefined && item.final.gate?.accepted === true && latestRulingFor(key, rulings)?.action === "approve";
  }).length ?? 0) : 0;
  const diff = artifact !== null && final?.applied !== undefined
    ? createTwoFilesPatch("before.html", "candidate.html", artifact.source, final.applied.text, "", "", { context: 3 }) : null;

  async function audit(): Promise<void> {
    if (live && (backend.client === null || user === null || !consent)) {
      setError("Sign in and confirm the excerpt notice before using a live model."); return;
    }
    resetRun(); const run = generation.current; setBusy(true);
    try {
      let proposer: FixProposer;
      if (mode === "rules") proposer = rulesProposer;
      else if (mode === "llm-A" || mode === "llm-B" || mode === "jev") proposer = createBrowserProposer(mode === "jev" ? "jev-choice" : mode, backend);
      else {
        // The sample adapter derives identities from the same original parse as the engine.
        let sample: FixProposer | null = null;
        proposer = { id: "mock", mode: "mock", async propose(finding, context, attempt) {
          if (sample === null) return { kind: "abstain", reason: "no_scripted_proposal" };
          return sample.propose(finding, context, attempt);
        } };
        const result = await runPage({ source, file, proposer,
          createEngine(page) { sample = sampleMockProposer(page); const next = createIframeEngine({ source: page, file }); engine.current = next; return next; },
          render(text, insertedTitleStart) { if (engine.current === null) throw new Error("engine_unavailable"); return engine.current.render(text, insertedTitleStart); } });
        await acceptAudit(result, run); return;
      }
      const result = await runPage({ source, file, proposer,
        createEngine(page) { const next = createIframeEngine({ source: page, file }); engine.current = next; return next; },
        render(text, insertedTitleStart) { if (engine.current === null) throw new Error("engine_unavailable"); return engine.current.render(text, insertedTitleStart); } });
      await acceptAudit(result, run);
    } catch (problem: unknown) { if (run === generation.current) setError(problemText(problem)); }
    finally { if (run === generation.current) setBusy(false); }
  }
  async function acceptAudit(result: Awaited<ReturnType<typeof runPage>>, run: number): Promise<void> {
    if (run !== generation.current) return;
    if (result.status !== "audited") { setError(result.reasons.map(words).join("; ")); engine.current?.close(); engine.current = null; return; }
    const next = result.artifact;
    const pageHash = await sha256Text(next.source);
    const nextKeys: Record<string, RulingKey> = {};
    for (const candidate of next.fixes) {
      if (candidate.finding.fingerprint === null || candidate.finding.ordinal === null || candidate.final.ops === undefined) continue;
      nextKeys[candidate.finding.fingerprint] = { pageSha256: pageHash, rule: candidate.finding.rule, ordinal: candidate.finding.ordinal,
        opsSha256: await sha256Text(JSON.stringify(candidate.final.ops)), engineProfile: next.baseline.profile };
    }
    if (run !== generation.current) return;
    setArtifact(next); setKeys(nextKeys);
    setSelected(Math.max(0, next.items.findIndex((item) => item.fix !== undefined)));
    publishDecisions(selectDecisionPage(decisionsRef.current, pageHash));
    try { const saved = await refreshDecisions(pageHash, run); if (saved !== null && !saved.trusted) setError(RECONCILE_DECISIONS); }
    catch { if (run === generation.current) setError("Audit complete, but saved decisions could not be confirmed. Export is blocked. Reload saved decisions to retry."); }
  }
  async function refreshDecisions(pageHash: string, run: number): Promise<DecisionState | null> {
    if (run !== generation.current) return null;
    const loading = { ...decisionsRef.current, trusted: false };
    if (loading.pageSha256 !== pageHash) throw new Error("rulings_page_mismatch");
    publishDecisions(loading);
    const history = await store.list(pageHash);
    if (run !== generation.current || decisionsRef.current !== loading) return null;
    const saved = reconcileDecisions(loading, history); publishDecisions(saved); return saved;
  }
  async function writeDecision(key: RulingKey, action: Ruling["action"]): Promise<void> {
    if (artifact === null || rulingBusy.current || busy || authBusy) return;
    const run = generation.current; rulingBusy.current = true; setBusy(true); setError(null);
    try {
      const intent = beginDecision(decisionsRef.current, key, action); publishDecisions(intent);
      await store.append(key, action);
      if (run !== generation.current || decisionsRef.current !== intent) return;
      const saved = await refreshDecisions(key.pageSha256, run);
      if (saved !== null && !saved.trusted) setError(RECONCILE_DECISIONS);
    } catch {
      if (run === generation.current) {
        publishDecisions({ ...decisionsRef.current, trusted: false });
        setError("The decision may already be saved, but its outcome could not be confirmed. Export is blocked. Reload saved decisions or retry the pending decision.");
      }
    } finally { if (run === generation.current) { rulingBusy.current = false; setBusy(false); } }
  }
  async function record(action: Ruling["action"]): Promise<void> {
    if (!decisionsRef.current.trusted || selectedKey === undefined || (action === "approve" && !accepted)) return;
    await writeDecision(selectedKey, action);
  }
  async function retryDecision(): Promise<void> {
    const intent = pendingDecision(decisionsRef.current);
    if (intent !== null) await writeDecision(intent.key, intent.action);
  }
  async function reloadDecisions(): Promise<void> {
    const pageHash = decisionsRef.current.pageSha256;
    if (artifact === null || pageHash === null || rulingBusy.current || busy || authBusy) return;
    const run = generation.current; rulingBusy.current = true; setBusy(true);
    try {
      const saved = await refreshDecisions(pageHash, run);
      if (saved !== null) setError(saved.trusted ? null : RECONCILE_DECISIONS);
    } catch { if (run === generation.current) setError("Saved decisions could not be reloaded. Export remains blocked. Retry reload or the pending decision."); }
    finally { if (run === generation.current) { rulingBusy.current = false; setBusy(false); } }
  }
  async function prepareExport(): Promise<void> {
    if (artifact === null || rulingBusy.current || busy || authBusy) return;
    try { rulingsForExport(decisionsRef.current); }
    catch { setError(RECONCILE_DECISIONS); return; }
    const pageHash = decisionsRef.current.pageSha256;
    if (pageHash === null) return;
    const run = generation.current; rulingBusy.current = true; setBusy(true);
    try {
      // Reconcile again immediately before combining. Cached approvals never select exported fixes.
      const saved = await refreshDecisions(pageHash, run);
      if (saved === null) return;
      const authoritative = rulingsForExport(saved); setError(null);
      const approved: CombineFix[] = [];
      for (const candidate of artifact.fixes) {
        const id = candidate.finding.fingerprint; const key = id === null ? undefined : keys[id]; const attempt = candidate.final;
        if (id !== null && key !== undefined && attempt.resolved !== undefined && attempt.gate?.accepted === true && latestRulingFor(key, authoritative)?.action === "approve") {
          approved.push({ id, key, resolved: attempt.resolved, gate: attempt.gate });
        }
      }
      if (approved.length === 0) { setError("No approved fixes remain in saved decisions."); return; }
      const result = await combineFixes({ page: artifact.page, baseline: artifact.baseline, engine: artifact.engine,
        fixes: approved, rulings: authoritative, sha256: sha256Text, render: artifact.render });
      if (run === generation.current && decisionsRef.current === saved && saved.trusted) { preparedDecisions.current = saved; setCombined(result); }
    } catch (problem: unknown) { if (run === generation.current) setError(problemText(problem)); }
    finally { if (run === generation.current) { rulingBusy.current = false; setBusy(false); } }
  }
  function canDownload(): boolean {
    try { rulingsForExport(decisionsRef.current); return preparedDecisions.current === decisionsRef.current; }
    catch { return false; }
  }
  function patchDownload(): void {
    if (busy || authBusy || rulingBusy.current || !canDownload() || artifact === null || combined?.state !== "ready") return;
    const patch = combinedPatch(artifact, combined); if (patch !== null) download("fixes.patch", patch, "text/x-diff");
  }
  async function reportDownload(): Promise<void> {
    if (busy || authBusy || rulingBusy.current || !canDownload() || artifact === null || combined?.state !== "ready") return;
    const run = generation.current; const saved = decisionsRef.current; setBusy(true);
    try { const report = await buildJsonReport(artifact, { sha256: sha256Text, engineProfileText, combined });
      if (run === generation.current && decisionsRef.current === saved && canDownload()) download("report.json", JSON.stringify(report, null, 2), "application/json"); }
    catch { if (run === generation.current) setError("Could not prepare the report. Please retry."); }
    finally { if (run === generation.current) setBusy(false); }
  }
  async function upload(fileToRead: File | undefined): Promise<void> {
    if (fileToRead === undefined) return;
    if (fileToRead.size > MAX_INPUT_BYTES) { setError("The file exceeds 200 KB (200,000 UTF-8 bytes)."); return; }
    resetRun(); const load = generation.current; setBusy(true);
    try {
      const bytes = await fileToRead.arrayBuffer();
      if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error("input_too_large");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (load === generation.current) { setSource(text); setFile(fileToRead.name); }
    } catch { if (load === generation.current) setError("Choose a valid UTF-8 HTML file at most 200 KB."); }
    finally { if (load === generation.current) setBusy(false); }
  }
  async function sessionAction(): Promise<void> {
    if (backend.client === null) return;
    setAuthBusy(true); setError(null);
    try {
      const result = user === null ? await backend.client.auth.signInAnonymously() : await backend.client.auth.signOut({ scope: "local" });
      if (result.error !== null) setError("Live sign-in could not be updated. Check anonymous auth settings or use demo mode.");
    } catch { setError("Live sign-in is unavailable. Demo mode is available."); }
    finally { setAuthBusy(false); }
  }

  return <div className="app-shell">
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <header className="topbar"><a className="brand" href="#workspace"><span className="brand-mark" aria-hidden="true">✓</span><span>Audit <em>&</em> Fix <small>VERIFIER</small></span></a>
      <div className="header-actions"><span className="mode-pill">{live ? "LIVE MODEL" : "OFFLINE PROPOSALS"}</span>
        <button type="button" className="button secondary compact" disabled={busy || authBusy || backend.client === null} onClick={() => void sessionAction()}>{authBusy ? "Updating session…" : user === null ? "Sign in for live models" : "Sign out"}</button></div></header>
    <main id="workspace" aria-busy={busy}>
      <div className="intro"><div><p className="eyebrow">ONE PAGE. EVERY CHANGE ACCOUNTED FOR.</p><h1>From finding to<br /><span>reviewable fix.</span></h1></div>
        <p className="intro-note">Audit a scratch copy, inspect each proposal, then approve the exact changes you want to export. Your original stays yours.</p></div>
      <div className="context-banner"><span className="status-dot" aria-hidden="true" />{backend.client === null ? "Offline demo · decisions stay in this tab" : user === null ? "Demo available · sign in to save private decisions and use live models" : "Signed in · private decisions belong to this session identity"}<span>Browser profile · stripped page copy</span></div>
      {backend.error !== null && <p className="setup-note">Live setup: {backend.error}. You can use demo proposals.</p>}
      <p className="session-note">Clearing an anonymous session loses access to its private rulings. Save your exports first. Audits use a stripped copy without page scripts or external styles; this is not a WCAG conformance result.</p>
      {error !== null && <div className="alert" role="alert">{words(error)}</div>}
      <div className="workspace-grid"><section className="panel input-panel" aria-labelledby="input-title">
        <div className="panel-heading"><div><p className="step-label">01 / SOURCE</p><h2 id="input-title">Start with your HTML</h2></div><button type="button" className="text-button" disabled={busy || authBusy} onClick={() => { resetRun(); setSource(SAMPLE_HTML); setFile("storefront.html"); setMode("mock"); setConsent(false); }}>Load sample</button></div>
        <label className="field-label" htmlFor="html-source">HTML source <span>{file}</span></label>
        <textarea id="html-source" spellCheck={false} value={source} disabled={busy || authBusy} onChange={(event) => { resetRun(); setSource(event.currentTarget.value); }} aria-describedby="input-limit" />
        <div className="input-meta" id="input-limit"><span className={inputBytes > MAX_INPUT_BYTES ? "over-limit" : ""}>{inputBytes.toLocaleString()} / 200,000 UTF-8 bytes</span><span>200 KB maximum</span></div>
        <label className="upload-label" htmlFor="html-upload">Or upload one UTF-8 HTML file</label><input id="html-upload" type="file" accept=".html,.htm,text/html" disabled={busy || authBusy} onChange={(event) => void upload(event.currentTarget.files?.[0])} />
        <label className="field-label proposer-label" htmlFor="proposer">Proposal method</label><select id="proposer" value={mode} disabled={busy || authBusy} onChange={(event) => { resetRun(); setMode(event.currentTarget.value as Mode); setConsent(false); }}>
          <option value="mock">Scripted sample · no model calls</option><option value="rules">Deterministic rules · no model calls</option><option value="llm-A" disabled={backend.client === null || user === null}>Live model A · sign-in required</option>
          <option value="llm-B" disabled={backend.client === null || user === null}>Live model B · sign-in required</option>
          <option value="jev" disabled={backend.client === null || user === null || !canUseJev(JevPolicySchema.parse(jevPolicy))}>Jev Choice · unretained / disabled until calibrated</option>
        </select>
        {live && <label className="consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.currentTarget.checked)} disabled={busy || authBusy} /><span>I understand live mode sends up to 4 KB of selected page excerpts to the configured provider. Calls use the server budget.</span></label>}
        <button type="button" className="button primary audit-button" disabled={busy || authBusy || source.length === 0 || inputBytes > MAX_INPUT_BYTES || (live && !consent)} onClick={() => void audit()}>{busy ? "Working…" : "Audit & propose"}<span aria-hidden="true">↗</span></button>
        <p className="fine-print">Downloads only. Proposals never change this input or the uploaded file.</p>
      </section><section className="results-column" aria-labelledby="results-title">
        <div className="stats" aria-live="polite"><div><span>Findings</span><strong>{artifact?.items.length ?? "—"}</strong></div><div><span>Code accepted</span><strong>{artifact === null ? "—" : acceptedCount}</strong></div><div><span>Approved</span><strong>{artifact === null ? "—" : approvedCount}</strong></div></div>
        <section className="panel findings-panel"><div className="panel-heading"><div><p className="step-label">02 / INSPECT</p><h2 id="results-title">The evidence, per fix</h2></div><span className="small-label">{artifact?.baseline.profile ?? "Awaiting audit"}</span></div>
          {artifact === null ? <div className="empty-state"><span className="empty-symbol" aria-hidden="true">⌘</span><h3>Bring a page. Keep the proof.</h3><p>Run the sample to explore mechanical fixes, human review, rejection and inconclusive outcomes. Actual results depend on the browser audit.</p></div> : <>
            {artifact.queue.truncatedCount > 0 && <p className="callout">Proposal queue truncated: {artifact.queue.truncatedCount} eligible findings remain unattempted. The full baseline audit is shown.</p>}
            <p className="coverage-note">{artifact.baseline.findings.length} violations · {artifact.baseline.incomplete.length} incomplete. Not measured: {artifact.baseline.notMeasured.join(", ") || "none declared by this profile"}.</p>
            {artifact.items.length === 0 ? <p className="empty-message">No findings returned by this completed audit. This does not establish overall accessibility.</p> : <ol className="finding-list">{artifact.items.map((item, index) => <li key={item.finding.fingerprint ?? `unmapped-${index}`}><button type="button" className={`finding-row ${index === selected ? "selected" : ""}`} disabled={busy || authBusy} onClick={() => setSelected(index)} aria-pressed={index === selected}>
              <span><strong>{item.finding.rule}</strong><small>{item.finding.cite === null ? "No source anchor" : `${item.finding.cite.file}:${item.finding.cite.line}:${item.finding.cite.col}`}</small></span><span className={`chip state-${item.state}`}>{words(item.state)}</span>
            </button></li>)}</ol>}
          </>}
        </section>
      </section></div>
      {artifact !== null && chosen !== undefined && <section className="panel detail-panel" aria-labelledby="detail-title"><div className="panel-heading"><div><p className="step-label">03 / DECIDE</p><h2 id="detail-title">{chosen.finding.rule}</h2></div><span className={`chip state-${chosen.state}`}>{words(chosen.state)}</span></div>
        <div className="detail-grid"><div><p className="detail-caption">Candidate patch · escaped source text</p>{diff === null ? <p className="no-patch">No patch was produced for this finding.</p> : <pre className="diff" tabIndex={0} aria-label="Candidate unified diff">{diff}</pre>}</div>
          <div className="decision-box"><h3>Code decides. You approve.</h3><p>{chosen.state === "checked" ? "A name exists and code checks passed; meaning still needs your review." : chosen.state === "verified" ? "Mechanical checks passed within this audit profile. Review the exact change before exporting." : "This proposal is not accepted for export."}</p>
            <ul className="reason-list">{chosen.reasons.map((reason, index) => <li key={`${reason}-${index}`}>{words(reason)}</li>)}</ul>
            {final?.gate !== undefined && <p className="fine-print">Name check: {words(final.gate.nameCheck)} · {fix?.attempts.length} attempt(s)</p>}
            <div className="decision-buttons"><button type="button" className="button primary" disabled={busy || authBusy || !decisions.trusted || !accepted || selectedKey === undefined} onClick={() => void record("approve")}>Approve exact fix</button><button type="button" className="button secondary" disabled={busy || authBusy || !decisions.trusted || selectedKey === undefined} onClick={() => void record("reject")}>Reject</button><button type="button" className="text-button" disabled={busy || authBusy || !decisions.trusted || selectedKey === undefined} onClick={() => void record("skip")}>Skip</button></div>
            <p className="decision-status" aria-live="polite">Recorded decision: <strong>{!decisions.trusted ? "unconfirmed" : decision === null ? "none" : decision.action}</strong></p>
          </div></div>
      </section>}
      <section className="export-panel" aria-labelledby="export-title"><div><p className="step-label">04 / EXPORT</p><h2 id="export-title">One combined check. One reviewable patch.</h2><p>Every included fix needs an exact approval, including mechanical fixes. The combined page is re-audited before downloads are enabled.</p></div><div className="export-actions"><button type="button" className="button primary" disabled={busy || authBusy || !decisions.trusted || artifact === null || approvedCount === 0} onClick={() => void prepareExport()}>Recheck approved fixes</button>
        <button type="button" className="button secondary" disabled={busy || authBusy || !downloadsReady} onClick={patchDownload}>Download patch</button><button type="button" className="button secondary" disabled={busy || authBusy || !downloadsReady} onClick={() => void reportDownload()}>Download JSON</button></div>
        {artifact !== null && !decisions.trusted && <div className="export-blocked" role="status"><p>{RECONCILE_DECISIONS}</p><button type="button" className="button secondary" disabled={busy || authBusy} onClick={() => void reloadDecisions()}>Reload saved decisions</button>{pending !== null && <button type="button" className="button secondary" disabled={busy || authBusy} onClick={() => void retryDecision()}>Retry pending {pending.action} decision</button>}</div>}
        {downloadsReady && combined?.state === "ready" && <p className="export-status" role="status">Ready: {combined.includedIds.length} approved fixes passed the combined check. After: {combined.after.findings.length} violations, {combined.after.incomplete.length} incomplete.</p>}
        {combined?.state === "blocked" && <div className="export-blocked" role="alert"><strong>Export blocked</strong><ul>{combined.reasons.map((reason) => <li key={reason}>{words(reason)}</li>)}</ul>{combined.conflicts.map(([a, b]) => <p key={`${a}-${b}`}>{a} conflicts with {b}</p>)}{combined.diagnostics.map((diagnostic, index) => <p key={index}>{words(diagnostic.kind)}: {diagnostic.ids.join(", ")} · {diagnostic.reasons.map(words).join("; ")}</p>)}</div>}
      </section><footer>Audit & Fix Verifier <span>Mechanical verification is profile-bound. Content stays pending human review. Axe passing is not correctness.</span></footer>
    </main>
  </div>;
}
