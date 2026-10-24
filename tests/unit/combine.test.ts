// what_bug_this_catches: stale/partial approvals exporting fixes, same-tag conflicts being applied silently,
// one target remaining in the combined page, multiple retags failing a single-retag invariant, and diagnostic
// bisection silently exporting successful halves. Uses stub audits, no engine execution. Written, never run.
import { describe, expect, it } from "vitest";
import type { AuditResult, Finding } from "../../src/core/audit/types.ts";
import type { Op } from "../../src/shared/opsSchema.ts";
import type { CombineFix, CombineInput, RulingKey } from "../../src/core/gate/combine.ts";
import { combineFixes } from "../../src/core/gate/combine.ts";
import { gateResult } from "../../src/core/gate/reasons.ts";
import { parsePage } from "../../src/core/html/parse.ts";
import { buildRenderCopy } from "../../src/core/html/renderCopy.ts";
import { resolveOps } from "../../src/core/ops/resolve.ts";
import { formatFingerprint } from "../../src/core/findings/fingerprint.ts";

const hash = async (text: string): Promise<string> => `test-hash:${text}`;
function finding(rule: string, ordinal: number): Finding {
  return { rule, ordinal, fingerprint: formatFingerprint(rule, ordinal), impact: "serious", cite: { file: "page.html", line: 1, col: 1 },
    unmappedReason: null, summary: null, contrast: null };
}
function audit(findings: readonly Finding[] = [], changes: Partial<AuditResult> = {}): AuditResult {
  return { status: "complete", findings, incomplete: [], engine: "jsdom", axeVersion: "test", profile: "test-profile",
    notMeasured: ["color-contrast", "label-content-name-mismatch"], errors: [], ...changes };
}
async function setup(source = '<html><head><title>Store</title></head><body><img src=a><img src=b></body></html>') {
  const page = parsePage(source);
  const make = async (id: string, rule: string, ordinal: number, makeOps: (fingerprint: string) => Op[]): Promise<CombineFix> => {
    const fingerprint = formatFingerprint(rule, ordinal);
    const outcome = resolveOps(page, { rule, fingerprint }, makeOps(fingerprint));
    if (!outcome.ok) throw new Error(outcome.reasons.join(","));
    return { id, resolved: outcome.resolved, gate: gateResult("strict", "checked"),
      key: { pageSha256: await hash(source), rule, ordinal, opsSha256: await hash(JSON.stringify(outcome.resolved.ops)), engineProfile: "test-profile" } };
  };
  const imgs = page.elements.filter((e) => e.tagName === "img");
  const fixes: CombineFix[] = [];
  for (const [i, image] of imgs.entries()) fixes.push(await make(`fix-${i}`, "image-alt", image.ordinal,
    (fingerprint) => [{ op: "set_attr", fingerprint, name: "alt", value: i === 0 ? "Mountain" : "Sea" }]));
  const base = fixes.map((f) => finding(f.key.rule, f.key.ordinal));
  const input = (changes: Partial<CombineInput> = {}): CombineInput => ({ page, baseline: audit(base), fixes,
    rulings: fixes.map((f, i) => ({ key: f.key, action: "approve", seq: i + 1 })), sha256: hash,
    render: (text, insertedTitleStart) => buildRenderCopy(text, { insertedTitleStart }).html,
    engine: { id: "jsdom", audit: async () => audit() }, ...changes });
  return { page, make, fixes, base, input };
}

describe("combined export authorization", () => {
  it("requires the exact five-field key, latest approval, and an accepted strict code gate", async () => {
    const s = await setup();
    const first = s.fixes[0];
    if (first === undefined) throw new Error("fixture");
    const mutations: Partial<RulingKey>[] = [
      { pageSha256: "other" }, { rule: "button-name" }, { ordinal: 99 }, { opsSha256: "other" }, { engineProfile: "other" },
    ];
    for (const mutation of mutations) {
      const result = await combineFixes(s.input({ fixes: [first], rulings: [{ key: { ...first.key, ...mutation }, action: "approve", seq: 1 }] }));
      expect(result).toMatchObject({ state: "blocked", reasons: [`exact_approval_required:${first.id}`] });
    }
    const rejected = await combineFixes(s.input({ rulings: [
      ...s.input().rulings, { key: first.key, action: "reject", seq: 99 },
    ] }));
    expect(rejected.state).toBe("blocked");
    expect(await combineFixes(s.input({ fixes: [{ ...first, gate: gateResult("strict", "rejected", ["bad_fix"]) }] })))
      .toMatchObject({ state: "blocked", reasons: [`fix_not_accepted:${first.id}`] });
    expect(await combineFixes(s.input({ fixes: [{ ...first, key: { ...first.key, opsSha256: "stale" } }] })))
      .toMatchObject({ state: "blocked", reasons: [`stale_fix_key:${first.id}`] });
  });

  it("blocks same-start-tag ranges without auditing or silently merging", async () => {
    const s = await setup();
    const first = s.fixes[0];
    if (first === undefined) throw new Error("fixture");
    const second = await s.make("same-tag", "image-alt", first.key.ordinal, (fingerprint) => [{ op: "mark_decorative", fingerprint }]);
    let calls = 0;
    const result = await combineFixes(s.input({ fixes: [first, second], rulings: [first, second].map((f, i) => ({ key: f.key, action: "approve", seq: i + 1 })),
      engine: { id: "jsdom", audit: async () => { calls++; return audit(); } } }));
    expect(result).toMatchObject({ state: "blocked", reasons: ["overlapping_ranges"], conflicts: [[first.id, second.id]] });
    expect(calls).toBe(0);
  });
});

describe("combined measurement and bisection", () => {
  it("audits the full combined page once and reports only that page's result", async () => {
    const s = await setup();
    let calls = 0;
    const result = await combineFixes(s.input({ engine: { id: "jsdom", audit: async (html) => {
      calls++; expect(html).toContain('alt="Mountain"'); expect(html).toContain('alt="Sea"'); return audit();
    } } }));
    expect(result).toMatchObject({ state: "ready", includedIds: ["fix-0", "fix-1"], after: { findings: [] } });
    expect(calls).toBe(1);
  });

  it("checks every target and identifies the failing subset without exporting another half", async () => {
    const s = await setup();
    const target = s.base[1];
    if (target === undefined) throw new Error("fixture");
    const result = await combineFixes(s.input({ engine: { id: "jsdom", audit: async (html) =>
      audit([...s.base.filter((_, i) => i === 0 && !html.includes('alt="Mountain"')), target]) } }));
    expect(result.state).toBe("blocked");
    if (result.state !== "blocked") return;
    expect(result.reasons).toContain("target_still_violating");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "failing_subset", ids: ["fix-1"] }));
    expect("text" in result).toBe(false);
  });

  it("names a measured interaction when each half passes separately", async () => {
    const s = await setup();
    const regression = finding("landmark-one-main", 0);
    let calls = 0;
    const result = await combineFixes(s.input({ engine: { id: "jsdom", audit: async (html) => {
      calls++;
      const mountain = html.includes('alt="Mountain"'); const sea = html.includes('alt="Sea"');
      return audit([...s.base.filter((_, i) => i === 0 ? !mountain : !sea), ...(mountain && sea ? [regression] : [])]);
    } } }));
    expect(result).toMatchObject({ state: "blocked", diagnostics: [{ kind: "interaction", ids: ["fix-0", "fix-1"] }] });
    expect(calls).toBe(3);
  });

  it("blocks inconclusive/mismatched audits and labels bounded diagnostics honestly", async () => {
    const s = await setup();
    expect(await combineFixes(s.input({ engine: { id: "jsdom", audit: async () => audit([], { profile: "other" }) } })))
      .toMatchObject({ state: "blocked", diagnostics: [{ kind: "inconclusive" }] });
    const result = await combineFixes(s.input({ maxDiagnosticAudits: 0, engine: { id: "jsdom", audit: async () => audit(s.base) } }));
    expect(result).toMatchObject({ state: "blocked", diagnostics: [{ kind: "budget_exhausted", ids: ["fix-0", "fix-1"] }] });
  });

  it("preserves multiple disjoint heading retags using the canonical M2 invariant checker", async () => {
    const s = await setup('<html><head><title>Store</title></head><body><h3>A</h3><h4>B</h4></body></html>');
    const headings = s.page.elements.filter((e) => /^h[1-6]$/.test(e.tagName));
    const fixes: CombineFix[] = [];
    for (const [i, heading] of headings.entries()) fixes.push(await s.make(`heading-${i}`, "heading-order", heading.ordinal,
      (fingerprint) => [{ op: "retag_heading", fingerprint, level: i + 1 }]));
    const result = await combineFixes(s.input({ fixes, baseline: audit(fixes.map((f) => finding(f.key.rule, f.key.ordinal))),
      rulings: fixes.map((f, i) => ({ key: f.key, action: "approve", seq: i + 1 })) }));
    expect(result).toMatchObject({ state: "ready", invariants: { ok: true } });
    if (result.state === "ready") expect(result.text).toContain('<h1>A</h1><h2>B</h2>');
  });
});
