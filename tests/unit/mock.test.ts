// what_bug_this_catches: missing/unloadable proposal replay fixtures, lost fingerprint binding, opaque invalid
// ops accepted by the loader instead of left to the schema, and timeout/abstention mapped to success.
// Written in Dirty Mode, never run. These are replay-loading units, not measured accessibility outcomes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/core/audit/types.ts";
import { formatFingerprint } from "../../src/core/findings/fingerprint.ts";
import { parsePage } from "../../src/core/html/parse.ts";
import { buildContext } from "../../src/core/proposers/context.ts";
import { createMockProposer, parseReplayScript } from "../../src/core/proposers/mock.ts";
import { parseProposal } from "../../src/shared/opsSchema.ts";

describe("checked-in proposal replay fixtures", () => {
  it.each([
    ["demo-tabindex.json", "tabindex", "proposal", true],
    ["demo-image-alt.json", "image-alt", "proposal", true],
    ["demo-delete-rejected.json", "image-alt", "proposal", false],
    ["demo-abstain.json", "image-alt", "abstain", null],
    ["demo-timeout.json", "image-alt", "inconclusive", null],
  ] as const)("loads and replays %s by fingerprint", async (filename, rule, kind, schemaValid) => {
    const script = parseReplayScript(JSON.parse(readFileSync(new URL(`../../fixtures/proposals/${filename}`, import.meta.url), "utf8")) as unknown);
    expect(script.fingerprint).toBe(formatFingerprint(rule, 4));
    expect(script.attempts).toHaveLength(1);
    const target: Finding = { rule, ordinal: 4, fingerprint: formatFingerprint(rule, 4), impact: "serious",
      cite: { file: "demo.html", line: 1, col: 1 }, unmappedReason: null, summary: null, contrast: null };
    const body = rule === "tabindex" ? '<div tabindex="3">Book details</div>' : '<img src="mountain-lake.jpg">';
    const page = parsePage(`<html lang="en"><head><title>Replay</title></head><body>${body}</body></html>`);
    const context = buildContext(page, target).context;
    const proposer = createMockProposer([script]);
    const response = await proposer.propose(target, context, { attempt: 1, reasons: [] });
    expect(response.kind).toBe(kind);
    if (response.kind === "proposal") expect(parseProposal(response.value).ok).toBe(schemaValid);
    if (response.kind === "abstain") expect(response.reason).toBe("no_pixels_or_meaningful_context");
    if (response.kind === "inconclusive") expect(response.reason).toBe("provider_timeout");
    const other = { ...target, ordinal: 5, fingerprint: formatFingerprint(rule, 5) };
    expect(await proposer.propose(other, context, { attempt: 1, reasons: [] }))
      .toEqual({ kind: "abstain", reason: "no_scripted_proposal" });
  });
});
