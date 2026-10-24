// what_bug_this_catches: the sixteen adversarial contracts regressing across schema/value/source/strict gates.
// IMPORTANT: the table below uses explicitly scripted AuditResults and source-derived audit simulation, NOT
// live axe measurements. Label-mismatch and injected baseline targets are deliberate unit evidence. Real-engine
// reproduction belongs to activation; the separately named jsdom contrast check below is an integration source.
// Written in Dirty Mode, never run.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AuditEngine, AuditResult, Finding } from "../../src/core/audit/types.ts";
import type { EngineId } from "../../src/core/rules.ts";
import { getAttr, parsePage } from "../../src/core/html/parse.ts";
import { buildRenderCopy, parseOrdinalMarker } from "../../src/core/html/renderCopy.ts";
import { formatFingerprint } from "../../src/core/findings/fingerprint.ts";
import { createMockProposer, parseReplayScript } from "../../src/core/proposers/mock.ts";
import { localVisibleText } from "../../src/core/proposers/context.ts";
import { runFix } from "../../src/core/loop/runFix.ts";
import { createJsdomEngine } from "../../src/node/jsdomEngine.ts";

const TRAPS = ["delete-to-pass", "hide-to-pass", "label-mismatch", "generic-name", "filename-alt", "wrong-language",
  "cascade-heading", "dangling-labelledby", "redundant-alt", "identical-siblings", "preexisting-finding", "malformed-html",
  "implied-html", "missing-title", "incomplete-after-fix", "injection"] as const;
interface Expected {
  what_bug_this_catches: string; target: { rule: string; ordinal: number | null }; oracle: { correct: boolean; reason: string };
  engines: Record<EngineId, { state: string; reasonIncludes?: string[]; nameCheck?: string; targetMeasured?: boolean }>;
}
function file(name: string, filename: string): string { return readFileSync(new URL(`../../fixtures/traps/${name}/${filename}`, import.meta.url), "utf8"); }
function node(rule: string, ordinal: number | null): Finding { return { rule, ordinal, fingerprint: ordinal === null ? null : formatFingerprint(rule, ordinal),
  impact: "serious", cite: ordinal === null ? null : { file: "scripted-trap.html", line: 1, col: 1 }, unmappedReason: ordinal === null ? "implied_element" : null,
  summary: "Explicit scripted unit target; not live axe evidence", contrast: rule === "color-contrast" ? { fgColor: "#aaaaaa", bgColor: "#ffffff", contrastRatio: 2.32, expectedContrastRatio: "4.5:1", fontSize: "16px", fontWeight: "400" } : null }; }
function result(engine: EngineId, findings: readonly Finding[], incomplete: readonly Finding[] = []): AuditResult {
  return { status: "complete", engine, findings, incomplete, axeVersion: "SCRIPTED-UNIT-NOT-AXE", profile: `scripted-unit-${engine}`,
    notMeasured: engine === "jsdom" ? ["color-contrast", "label-content-name-mismatch"] : [], errors: [] };
}
/** A small explicit source model sufficient for the contracts; it does not pretend to implement axe. */
function simulatedAfter(name: string, engine: EngineId, target: Finding, render: string): AuditResult {
  const page = parsePage(render);
  const elements = page.entries.filter((e) => !e.inTemplate);
  const ordinal = (entry: (typeof elements)[number]): number | null => parseOrdinalMarker(getAttr(entry, "data-a11y-ord"));
  if (target.rule === "image-alt") return result(engine, elements.filter((e) => e.tagName === "img" && getAttr(e, "alt") === null).map((e) => node("image-alt", ordinal(e))));
  if (target.rule === "html-has-lang") return result(engine, elements.some((e) => e.tagName === "html" && (getAttr(e, "lang") ?? "") !== "") ? [] : [target]);
  if (target.rule === "document-title") return result(engine, page.titles.some((t) => t.text.trim() !== "") ? [] : [target]);
  if (target.rule === "heading-order") {
    let previous = 0; const findings: Finding[] = [];
    for (const entry of elements.filter((e) => /^h[1-6]$/.test(e.tagName))) {
      const level = Number(entry.tagName.slice(1)); if (previous > 0 && level > previous + 1) findings.push(node("heading-order", ordinal(entry))); previous = level;
    }
    return result(engine, findings);
  }
  if (target.rule === "color-contrast") return engine === "jsdom" ? result(engine, []) : result(engine, [], [target]);
  const entry = elements.find((e) => ordinal(e) === target.ordinal);
  const repaired = entry !== undefined && ["aria-label", "aria-labelledby", "title"].some((attr) => (getAttr(entry, attr) ?? "") !== "");
  const mismatch = name === "label-mismatch" && engine === "iframe" && entry !== undefined && repaired && getAttr(entry, "aria-label") !== localVisibleText(entry.node);
  return result(engine, [...(repaired ? [] : [target]), ...(mismatch ? [node("label-content-name-mismatch", target.ordinal)] : [])]);
}

describe("sixteen traps: SCRIPTED unit contracts, not live engine measurements", () => {
  for (const name of TRAPS) for (const engine of ["jsdom", "iframe"] as const) it(`${name} / ${engine} scripted contract`, async () => {
    const source = file(name, "page.html");
    const expected = JSON.parse(file(name, "expected.json")) as Expected;
    const script = parseReplayScript(JSON.parse(file(name, "proposal.json")) as unknown);
    expect(expected.what_bug_this_catches.length).toBeGreaterThan(0);
    const page = parsePage(source); const target = node(expected.target.rule, expected.target.ordinal);
    const contract = expected.engines[engine];
    const simulated = simulatedAfter(name, engine, target, buildRenderCopy(source).html);
    if (contract.targetMeasured === false) {
      expect(contract.state).toBe("not_measured"); expect(simulated.notMeasured).toContain(target.rule);
      expect(simulated.findings.some((f) => f.rule === "color-contrast")).toBe(false); return;
    }
    // The target may be a deliberately planted synthetic baseline (e.g. visible text already names a button).
    const baseline = { ...simulated, incomplete: [], findings: simulated.findings.some((f) => f.fingerprint === target.fingerprint) ? simulated.findings : [...simulated.findings, target] };
    const adapter: AuditEngine = { id: engine, audit: async (render) => simulatedAfter(name, engine, target, render) };
    const fix = await runFix({ page, finding: target, baseline, engine: adapter, proposer: createMockProposer([script]), file: `${name}.html`,
      render: (text, insertedTitleStart) => buildRenderCopy(text, { insertedTitleStart }).html });
    expect(fix.final.state).toBe(contract.state);
    for (const reason of contract.reasonIncludes ?? []) expect(fix.final.reasons).toContain(reason);
    if (contract.nameCheck !== undefined) expect(fix.final.gate?.nameCheck).toBe(contract.nameCheck);
    if (fix.final.stage === "schema" || fix.final.stage === "value" || fix.final.stage === "matrix") expect(fix.final.gate).toBeUndefined();
    if (name === "wrong-language") { expect(fix.final.state).toBe("verified"); expect(expected.oracle.correct).toBe(false); }
    if (fix.final.state === "checked" || fix.final.state === "verified") {
      expect(fix.final.gate?.accepted).toBe(true); expect(fix.final.invariants?.ok).toBe(true);
      for (const op of fix.final.ops ?? []) expect(JSON.stringify(op)).not.toContain("CANARY-");
    }
    if (name === "preexisting-finding" || name === "identical-siblings") expect(fix.final.after?.findings.some((f) => f.fingerprint !== target.fingerprint)).toBe(true);
  });
});

it("ACTUAL jsdom integration source: excluded contrast has no color-contrast finding (not executed in Dirty Mode)", async () => {
  const source = file("incomplete-after-fix", "page.html"); const page = parsePage(source);
  const audit = await createJsdomEngine({ source: page, file: "contrast.html" }).audit(buildRenderCopy(source).html);
  expect(audit.status).toBe("complete"); expect(audit.notMeasured).toContain("color-contrast");
  expect([...audit.findings, ...audit.incomplete].some((f) => f.rule === "color-contrast")).toBe(false);
});
