// what_bug_this_catches: the lang value gate accepting malformed tags ("en_US", "en-", "english-language-tag")
// or rejecting well-formed ones (scripts, numeric regions, variants, extensions, private use, grandfathered).
// Syntax only: it cannot catch a well-formed but WRONG language (the wrong-language trap is a documented strict
// false accept). Written in Dirty Mode, not run.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isWellFormedBcp47, parseBcp47, primaryLanguage } from "../../src/core/values/bcp47.ts";

describe("BCP 47 well-formedness", () => {
  it("accepts well-formed tags", () => {
    for (const tag of [
      "en",
      "EN",
      "en-US",
      "es-419",
      "zh-Hant-TW",
      "sr-Latn-RS",
      "de-CH-1996",
      "sl-rozaj-biske",
      "zh-yue-HK",
      "en-a-bbb-x-a-ccc",
      "en-US-u-ca-gregory",
      "x-whatever",
      "qaa-Qaaa-QM-x-southern",
      "i-klingon",
      "en-GB-oed",
      "zh-min-nan",
      "haw",
      "tlh",
    ]) {
      expect(isWellFormedBcp47(tag), tag).toBe(true);
    }
  });

  it("rejects malformed tags", () => {
    for (const tag of [
      "",
      "e",
      "en_US",
      "en-",
      "-en",
      "en--US",
      "en US",
      " en",
      "123",
      "abcdefghi",
      "en-US-u",
      "en-a",
      "x",
      "x-",
      "en-x",
      "de-1996-1996",
      "en-a-bbb-a-ccc",
      "en-US-abcdefghi",
      "en-Latn-Latn",
      "ja-日本",
    ]) {
      expect(isWellFormedBcp47(tag), JSON.stringify(tag)).toBe(false);
    }
  });

  // what_bug_this_catches: case folding before the alphabet check. "\u212A".toLowerCase() is ASCII "k", so a
  // parser that lower-cases first accepts "\u212Aa" (KELVIN SIGN + "a") as the tag "ka" and writes a non-ASCII lang.
  it("rejects non-ASCII input before case folding (Kelvin sign, full-width letters, Unicode hyphens)", () => {
    expect("\u212A".toLowerCase()).toBe("k"); // the trap itself
    for (const tag of [
      "\u212Aa", // KELVIN SIGN + a -> "ka" after toLowerCase
      "en-\u212Aa",
      "\uFF45\uFF4E", // FULLWIDTH "en" (NFKC would fold it to ASCII; the gate must not)
      "en-\uFF35\uFF33", // FULLWIDTH region "US"
      "en\u2011US", // NON-BREAKING HYPHEN
      "\u0130t", // LATIN CAPITAL I WITH DOT ABOVE
      "e\u017F", // LATIN SMALL LONG S (folds to "s" under Unicode case folding)
    ]) {
      expect(isWellFormedBcp47(tag), JSON.stringify(tag)).toBe(false);
      expect(parseBcp47(tag).ok, JSON.stringify(tag)).toBe(false);
      expect(primaryLanguage(tag), JSON.stringify(tag)).toBeNull();
    }
  });

  it("splits the parts", () => {
    const r = parseBcp47("zh-Hant-TW");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parts.language).toBe("zh");
      expect(r.parts.script).toBe("hant");
      expect(r.parts.region).toBe("tw");
    }
    expect(primaryLanguage("es-419")).toBe("es");
    expect(primaryLanguage("x-private")).toBeNull();
    expect(primaryLanguage("en_US")).toBeNull();
  });

  it("property: tags built from the grammar are always well-formed", () => {
    const alpha = (min: number, max: number) =>
      fc.stringMatching(new RegExp(`^[a-z]{${min},${max}}$`));
    fc.assert(
      fc.property(
        alpha(2, 3),
        fc.option(fc.stringMatching(/^[A-Z][a-z]{3}$/), { nil: undefined }),
        fc.option(fc.oneof(fc.stringMatching(/^[A-Z]{2}$/), fc.stringMatching(/^[0-9]{3}$/)), { nil: undefined }),
        (language, script, region) => {
          const tag = [language, script, region].filter((p) => p !== undefined).join("-");
          return isWellFormedBcp47(tag);
        },
      ),
    );
  });

  // Generators below avoid fc.fullUnicode / fc.fullUnicodeString / fc.string({ unit }) so they work on both
  // fast-check 3.x and 4.x (the pin is chosen at activation): any code point is drawn as an integer instead.
  const TAG_CHARS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"];
  const isTagChar = (c: string): boolean => /^[A-Za-z0-9-]$/.test(c);
  const tagChar = fc.constantFrom(...TAG_CHARS);
  /** Exactly one code point outside [A-Za-z0-9-]: case-folding traps and lookalikes (weighted 3:1), or anything. */
  const foreignChar = fc.oneof(
    {
      weight: 3,
      arbitrary: fc.constantFrom(
        "\u212A", // KELVIN SIGN, lower-cases to ASCII "k"
        "\u212B", // ANGSTROM SIGN
        "\u0130", // LATIN CAPITAL I WITH DOT ABOVE
        "\u0131", // LATIN SMALL DOTLESS I
        "\u017F", // LATIN SMALL LONG S
        "\uFF45", // FULLWIDTH e
        "\uFF2E", // FULLWIDTH N
        "\u0435", // CYRILLIC SMALL IE (looks like "e")
        "\u00E9",
        "\u2010", // HYPHEN
        "\u2011", // NON-BREAKING HYPHEN
        "\u00A0",
        "\u200B",
        "_",
        " ",
      ),
    },
    {
      weight: 1,
      arbitrary: fc
        .integer({ min: 0, max: 0x10ffff })
        .filter((cp) => cp < 0xd800 || cp > 0xdfff)
        .map((cp) => String.fromCodePoint(cp))
        .filter((c) => !isTagChar(c)),
    },
  );

  it("property: any tag containing a character outside [A-Za-z0-9-] is rejected", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(tagChar, foreignChar), { minLength: 1, maxLength: 20 }).map((cs) => cs.join("")),
        (s) => !/[^A-Za-z0-9-]/.test(s) || !isWellFormedBcp47(s),
      ),
    );
  });

  it("property: inserting one non-ASCII or other foreign code point into a well-formed tag makes it malformed", () => {
    // Insertion (rather than random strings) keeps the rest of the tag well-formed, so a parser that case-folds
    // before checking the alphabet is caught: e.g. "en" + KELVIN SIGN -> "en\u212A" -> "enk" would be accepted.
    const wellFormed = fc
      .tuple(
        fc.stringMatching(/^[a-z]{2,3}$/),
        fc.option(fc.stringMatching(/^[A-Z][a-z]{3}$/), { nil: undefined }),
        fc.option(fc.oneof(fc.stringMatching(/^[A-Z]{2}$/), fc.stringMatching(/^[0-9]{3}$/)), { nil: undefined }),
      )
      .map((parts) => parts.filter((p) => p !== undefined).join("-"));
    fc.assert(
      fc.property(wellFormed, foreignChar, fc.nat(), (tag, bad, pos) => {
        if (!isWellFormedBcp47(tag)) return false;
        const at = pos % (tag.length + 1);
        return !isWellFormedBcp47(tag.slice(0, at) + bad + tag.slice(at));
      }),
    );
  });
});
