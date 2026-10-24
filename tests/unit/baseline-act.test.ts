// what_bug_this_catches: unstable/partial baselines entering eval, lost unanchored counts, or ACT redirects/URLs
// escaping the W3C allowlist. Tests use no network and never invoke fetchPinnedActCase/fetch-act. Written, not run.
import { describe, expect, it } from "vitest";
import type { AuditResult, Finding } from "../../src/core/audit/types.ts";
import { baselinesMatch, auditBaselineTwice } from "../../src/node/baseline.ts";
import { ActFetchManifestSchema, validateActUrl } from "../../src/node/act.ts";
function f(ordinal: number | null): Finding { return { rule: "image-alt", ordinal, fingerprint: ordinal === null ? null : `image-alt:${ordinal}`, impact: "serious", cite: null, unmappedReason: ordinal === null ? "no_source_anchor" : null, summary: null, contrast: null }; }
function a(findings: readonly Finding[] = []): AuditResult { return { status: "complete", findings, incomplete: [], engine: "jsdom", profile: "unit", axeVersion: "unit", notMeasured: [], errors: [] }; }
describe("stable baseline eligibility", () => {
  it("compares full fingerprint sets independent of order, and unanchored counts", () => {
    expect(baselinesMatch(a([f(1), f(2)]), a([f(2), f(1)]))).toBe(true);
    expect(baselinesMatch(a([f(1)]), a([f(2)]))).toBe(false);
    expect(baselinesMatch(a([f(null)]), a([f(null), f(null)]))).toBe(false);
    expect(baselinesMatch(a([f(1)]), { ...a(), incomplete: [f(1)] })).toBe(false);
    expect(baselinesMatch(a(), { ...a(), status: "partial" })).toBe(false);
    expect(baselinesMatch(a(), { ...a(), profile: "other" })).toBe(false);
  });
  it("audits twice and reports error/instability without fabricating empty successful results", async () => {
    let count = 0;
    const changed = await auditBaselineTwice({ id: "jsdom", audit: async () => ++count === 1 ? a([f(1)]) : a() }, "same-render");
    expect(count).toBe(2); expect(changed.stable).toBe(false);
    const thrown = await auditBaselineTwice({ id: "jsdom", audit: async () => { throw new Error("failed"); } }, "same-render");
    expect(thrown).toMatchObject({ stable: false, first: null, second: null, reasons: ["baseline_audit_error"] });
  });
});
describe("ACT explicit URL/pin inputs (no fetch)", () => {
  it("allows only the declared official HTTPS paths", () => {
    expect(validateActUrl("https://www.w3.org/WAI/standards-guidelines/act/rules/example/").hostname).toBe("www.w3.org");
    for (const url of ["http://www.w3.org/WAI/standards-guidelines/act/a", "https://evil.test/WAI/standards-guidelines/act/a", "https://www.w3.org.evil.test/WAI/standards-guidelines/act/a", "https://user:pass@www.w3.org/WAI/standards-guidelines/act/a", "https://www.w3.org:444/WAI/standards-guidelines/act/a", "https://www.w3.org/private/a"]) expect(() => validateActUrl(url)).toThrow();
  });
  it("requires explicit sha256 pins, safe cache ids and a rule mapping", () => {
    const entry = { id: "case-a", actRuleId: "example", axeRule: "image-alt", expectation: "failed", url: "https://www.w3.org/WAI/standards-guidelines/act/a", sha256: "a".repeat(64) };
    expect(ActFetchManifestSchema.safeParse({ schemaVersion: 1, cases: [entry] }).success).toBe(true);
    expect(ActFetchManifestSchema.safeParse({ schemaVersion: 1, cases: [{ ...entry, sha256: "" }] }).success).toBe(false);
    expect(ActFetchManifestSchema.safeParse({ schemaVersion: 1, cases: [{ ...entry, id: "../escape" }] }).success).toBe(false);
  });
});
