// what_bug_this_catches: selector/HTML text being mistaken for a source ordinal, marker spoofing, absent
// anchors becoming fake passes, wrong source citations after serialization, or check errors becoming complete.
// Written in Dirty Mode, never run.
import { describe, expect, it } from "vitest";
import type { AxeResultsLike, NormalizeOptions, TrustedMarkers } from "../../src/core/findings/normalize.ts";
import { normalizeAudit } from "../../src/core/findings/normalize.ts";
import { parsePage } from "../../src/core/html/parse.ts";

const source = parsePage('\ufeff<html>\n<head></head><body>\n  <img>\n</body></html>');
const ordinal = source.elements.find((e) => e.tagName === "img")?.ordinal;
if (ordinal === undefined) throw new Error("fixture");
function options(markers: TrustedMarkers | null): NormalizeOptions {
  return { source, file: "store.html", engine: "jsdom", axeVersion: "test", profile: "test", notMeasured: [], resolveTarget: () => markers };
}
const raw: AxeResultsLike = { violations: [{ id: "image-alt", nodes: [{ target: ["img[data-a11y-ord='999']"], failureSummary: "Missing alt" }] }], incomplete: [] };

describe("normalization", () => {
  it("takes identity from the actual audited node markers and cites original BOM-adjusted source", () => {
    const result = normalizeAudit(raw, options({ ordinal: String(ordinal), unanchored: null }));
    expect(result.findings[0]).toMatchObject({ ordinal, fingerprint: `image-alt:${ordinal}`, cite: { file: "store.html", line: 3, col: 3 }, unmappedReason: null });
  });
  it.each([null, { ordinal: "999", unanchored: null }, { ordinal: "01", unanchored: null },
    { ordinal: String(ordinal), unanchored: "implied_element" }])("leaves missing/invalid/ambiguous markers unmapped: %j", (markers) => {
    expect(normalizeAudit(raw, options(markers)).findings[0]).toMatchObject({ ordinal: null, fingerprint: null, cite: null, unmappedReason: "unmapped" });
  });
  it("retains implied/clone reasons and refuses page-level findings on a non-html marker", () => {
    expect(normalizeAudit(raw, options({ ordinal: null, unanchored: "no_source_anchor" })).findings[0]?.unmappedReason).toBe("no_source_anchor");
    const page = { violations: [{ id: "html-has-lang", nodes: [{ target: ["img"] }] }], incomplete: [] };
    expect(normalizeAudit(page, options({ ordinal: String(ordinal), unanchored: null })).findings[0]?.fingerprint).toBeNull();
    const implied = parsePage("<img>");
    expect(normalizeAudit(page, { ...options(null), source: implied }).findings[0]?.unmappedReason).toBe("implied_element");
  });
  it("keeps ordinary incomplete nodes and contrast data, and flags execution errors as partial", () => {
    const contrast = { violations: [], incomplete: [{ id: "color-contrast", nodes: [{ target: ["img"], any: [{ data: { fgColor: "red", contrastRatio: 2.2 } }] }] }] };
    expect(normalizeAudit(contrast, options({ ordinal: String(ordinal), unanchored: null }))).toMatchObject({ status: "complete", incomplete: [{ contrast: { fgColor: "red", contrastRatio: 2.2 } }] });
    const partial = { violations: [], incomplete: [{ id: "color-contrast", nodes: [{ target: ["img"], any: [{ data: { error: "canvas unavailable" } }] }] }] };
    expect(normalizeAudit(partial, options(null)).status).toBe("partial");
  });
});
