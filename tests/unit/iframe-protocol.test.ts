// what_bug_this_catches: forged-window/token messages, unbounded or malformed payloads, profile drift and
// ordinal aliasing through duplicate node keys. Pure schema/source checks; no iframe/browser execution.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRunnerMessage } from "../../src/engines/iframe/csp.ts";
const source = {}; const token = "a".repeat(48);
const expected = { source, token, profile: "iframe-unit", axeVersion: "unit", notMeasured: [] };
function message() { return { runToken: token, engine: "iframe", status: "complete", profile: "iframe-unit", axeVersion: "unit", notMeasured: [], violations: [], incomplete: [], errors: [] }; }
describe("iframe host protocol", () => {
  it("accepts only the exact source/token and a complete validated envelope", () => {
    expect(parseRunnerMessage({ source: {}, data: message() }, expected).kind).toBe("ignore");
    expect(parseRunnerMessage({ source, data: { ...message(), runToken: "b".repeat(48) } }, expected).kind).toBe("ignore");
    expect(parseRunnerMessage({ source, data: message() }, expected).kind).toBe("result");
    expect(parseRunnerMessage({ source, data: { ...message(), status: "future" } }, expected)).toEqual({ kind: "error", reason: "iframe_message_invalid" });
  });
  it("refuses oversized UTF8 data and engine/profile/version/coverage drift", () => {
    expect(parseRunnerMessage({ source, data: { ...message(), huge: "😀".repeat(600000) } }, expected)).toEqual({ kind: "error", reason: "iframe_message_too_large" });
    for (const change of [{ profile: "other" }, { axeVersion: "other" }, { notMeasured: ["color-contrast"] }]) expect(parseRunnerMessage({ source, data: { ...message(), ...change } }, expected)).toEqual({ kind: "error", reason: "iframe_profile_mismatch" });
    expect(parseRunnerMessage({ source, data: { ...message(), engine: "jsdom" } }, expected).kind).toBe("error");
  });
  it("rejects duplicate node keys rather than aliasing trusted markers", () => {
    const node = { key: "n0", markers: { ordinal: "4", unanchored: null }, impact: null, summary: null, contrast: null, executionError: false };
    const rule = { id: "image-alt", impact: null, nodes: [node, node], executionError: false };
    expect(parseRunnerMessage({ source, data: { ...message(), violations: [rule] } }, expected)).toEqual({ kind: "error", reason: "iframe_message_invalid" });
  });
  it("declares exact srcdoc assignment, bounded host timeout and own-frame cleanup without app HTML insertion", () => {
    const host = readFileSync(new URL("../../src/engines/iframe/host.ts", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../../src/engines/iframe/runner.ts", import.meta.url), "utf8");
    const app = readFileSync(new URL("../../src/app/App.tsx", import.meta.url), "utf8");
    expect(host).toContain("frame.srcdoc = renderCopy"); expect(host).toContain("15000"); expect(host).toContain("frame.remove()");
    expect(runner).toContain('"DOMContentLoaded"'); expect(runner).toContain("library.remove(); bootstrap?.remove()");
    expect(host).not.toContain(".innerHTML"); expect(app).not.toContain("dangerouslySetInnerHTML");
  });
});
