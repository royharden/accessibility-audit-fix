// Test source only; generator and assertions have never executed in Dirty Mode.
import { describe, expect, it } from "vitest";
import { generateCorpus, plantedRuleCounts, GENERATED_RULES } from "../../src/node/fixtures/generate.ts";
import { createPrng } from "../../src/node/fixtures/prng.ts";
import { parsePage, getAttr } from "../../src/core/html/parse.ts";
import { MAX_INPUT_BYTES, utf8ByteLength } from "../../src/core/limits.ts";

describe("frozen corpus construction", () => {
  it("is deterministic by seed and changes content for another seed", () => {
    expect(generateCorpus(20261024)).toEqual(generateCorpus(20261024));
    expect(generateCorpus(20261024).map((page) => page.source)).not.toEqual(generateCorpus(20261025).map((page) => page.source));
    expect(() => createPrng(-1)).toThrow();
  });
  it("keeps exactly40 pages,20/20 and disjoint template families", () => {
    const pages = generateCorpus(20261024);
    expect(pages).toHaveLength(40);
    const dev = pages.filter((page) => page.split === "dev"); const heldout = pages.filter((page) => page.split === "heldout");
    expect(dev).toHaveLength(20); expect(heldout).toHaveLength(20);
    const devFamilies = new Set(dev.map((page) => page.family));
    expect(heldout.every((page) => !devFamilies.has(page.family))).toBe(true);
    expect(new Set(pages.map((page) => page.id)).size).toBe(40);
  });
  it("plants six anchored defects/page and meets every planted heldout quota", () => {
    const pages = generateCorpus(20261024); const counts = plantedRuleCounts(pages, "heldout");
    for (const rule of GENERATED_RULES) expect(counts[rule]).toBeGreaterThanOrEqual(10);
    for (const page of pages) {
      expect(page.defects).toHaveLength(6); expect(utf8ByteLength(page.source)).toBeLessThanOrEqual(MAX_INPUT_BYTES);
      const parsed = parsePage(page.source);
      for (const defect of page.defects) {
        if (defect.rule === "html-has-lang" || defect.rule === "document-title") expect(defect.ordinal).toBe(parsed.htmlOrdinal);
        else {
          const element = parsed.elements[defect.ordinal]; expect(element).toBeDefined();
          const entry = element === undefined ? undefined : parsed.entries[element.entry];
          expect(entry === undefined ? null : getAttr(entry, "data-fixture-target")).toBe(defect.rule);
        }
      }
    }
  });
});
