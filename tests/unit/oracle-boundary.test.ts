// what_bug_this_catches: code-verified wrong language being called semantically correct, target keywords
// matching only fragments, and proposer/gate/app imports exposing hidden oracle or Node eval modules.
// Written in Dirty Mode, never run.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GoldDefect } from "../../gold/oracle/schema.ts";
import type { Op } from "../../src/shared/opsSchema.ts";
import type { FixAttempt } from "../../src/core/ledger/types.ts";
import { parsePage } from "../../src/core/html/parse.ts";
import { visibleBodyText, handlerPrints, checkInvariants } from "../../src/core/html/invariants.ts";
import { resolveOps } from "../../src/core/ops/resolve.ts";
import { applyResolved } from "../../src/core/ops/apply.ts";
import { judgeGoldDefect } from "../../src/node/oracle.ts";

function candidate(source: string, rule: string, ordinal: number, ops: readonly Op[]) {
  const page = parsePage(source); const outcome = resolveOps(page, { rule, fingerprint: `${rule}:${ordinal}` }, ops);
  if (!outcome.ok) throw new Error(outcome.reasons.join(","));
  const applied = applyResolved(page, outcome.resolved); if (!applied.ok) throw new Error(applied.reason);
  const attempt: FixAttempt = { number: 1, state: "verified", stage: "gate", reasons: [], resolved: outcome.resolved, applied,
    invariants: checkInvariants(page, outcome.resolved, applied) };
  return { page, attempt, preserve: { visibleBodyText: visibleBodyText(page), handlerCount: handlerPrints(page).length } };
}
describe("semantic oracle", () => {
  it("does not confuse BCP47 syntax/code acceptance with language truth", () => {
    const source = '<html><head><title>Visita</title></head><body><p>Bienvenidos a nuestra colección.</p></body></html>';
    const c = candidate(source, "html-has-lang", 0, [{ op: "set_attr", fingerprint: "html-has-lang:0", name: "lang", value: "en" }]);
    const defect: GoldDefect = { rule: "html-has-lang", ordinal: 0, truth: { language: "es" }, mustPreserve: c.preserve };
    expect(c.attempt.invariants?.ok).toBe(true); expect(judgeGoldDefect(c.page, defect, c.attempt).correct).toBe(false);
  });
  it("judges the actual applied name with word-boundary keywords and preservation", () => {
    const source = '<button onclick="keep()"></button>';
    const c = candidate(source, "button-name", 0, [{ op: "set_attr", fingerprint: "button-name:0", name: "aria-label", value: "Reserve tickets" }]);
    const defect: GoldDefect = { rule: "button-name", ordinal: 0, truth: { keywords: ["reserve", "tickets"] }, mustPreserve: c.preserve };
    expect(judgeGoldDefect(c.page, defect, c.attempt).correct).toBe(true);
    expect(judgeGoldDefect(c.page, { ...defect, truth: { keywords: ["serve"] } }, c.attempt).correct).toBe(false);
    expect(judgeGoldDefect(c.page, { ...defect, mustPreserve: { ...c.preserve, handlerCount: 0 } }, c.attempt).correct).toBe(false);
    expect(judgeGoldDefect(c.page, defect, { number: 1, state: "rejected", stage: "schema", reasons: [] }).correct).toBeNull();
  });
});

it("production proposer/gate/app/shared import graph cannot reach gold or Node evaluation", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sourceFiles: string[] = [];
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name);
      if (item.isDirectory()) walk(path); else if (/\.[cm]?tsx?$/.test(item.name)) sourceFiles.push(path);
    }
  };
  for (const directory of ["src/core", "src/shared", "src/app"]) walk(resolve(root, directory));
  for (const path of sourceFiles) {
    const source = readFileSync(path, "utf8");
    const imports = source.matchAll(/(?:\b(?:import|export)\s[\s\S]*?\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g);
    for (const match of imports) {
      const spec = match[1] ?? match[2] ?? "";
      const target = spec.startsWith(".") ? relative(root, resolve(dirname(path), spec)).split(sep).join("/") : spec;
      expect(target, `${relative(root, path)} imports ${spec}`).not.toMatch(/^(?:gold(?:\/|$)|src\/node(?:\/|$))|(?:^|\/)gold\//);
    }
  }
  const lint = readFileSync(resolve(root, "eslint.config.js"), "utf8");
  expect(lint).toContain('under(target, "gold")'); expect(lint).toContain('"no-restricted-imports"');
});
