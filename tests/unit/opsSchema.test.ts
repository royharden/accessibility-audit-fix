// what_bug_this_catches: the op whitelist drifting (extra op kinds or attributes, unknown keys accepted, more than
// two ops, empty alt written through set_attr instead of mark_decorative, tabindex values other than "0",
// mixed ops+abstain payloads, ops aimed at different findings). Written in Dirty Mode, not run.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_OPS_PER_PROPOSAL,
  OP_KINDS,
  OP_SCHEMA_REASONS,
  SET_ATTR_NAMES,
  isAbstain,
  parseOp,
  parseProposal,
} from "../../src/core/ops/index.ts";

const FP = "image-alt:12";

const VALID_OPS: readonly unknown[] = [
  { op: "set_attr", fingerprint: FP, name: "alt", value: "Red running shoe" },
  { op: "set_attr", fingerprint: "tabindex:3", name: "tabindex", value: "0" },
  { op: "remove_attr", fingerprint: "tabindex:3", name: "tabindex" },
  { op: "set_style_color", fingerprint: "color-contrast:7", property: "color", value: "#1a1a1a" },
  { op: "retag_heading", fingerprint: "heading-order:9", level: 3 },
  { op: "set_document_title", fingerprint: "document-title:0", text: "Shoe store" },
  { op: "mark_decorative", fingerprint: FP },
];

describe("ops schema", () => {
  it("has exactly the six whitelisted op kinds and six set_attr names", () => {
    expect([...OP_KINDS].sort()).toEqual(
      ["mark_decorative", "remove_attr", "retag_heading", "set_attr", "set_document_title", "set_style_color"].sort(),
    );
    expect([...SET_ATTR_NAMES].sort()).toEqual(["alt", "aria-label", "aria-labelledby", "lang", "tabindex", "title"].sort());
    expect(MAX_OPS_PER_PROPOSAL).toBe(2);
  });

  it("accepts every valid op shape", () => {
    for (const op of VALID_OPS) expect(parseOp(op).ok, JSON.stringify(op)).toBe(true);
  });

  it("rejects unknown op kinds and removed spec ops (set_attr for, remove_attr aria-hidden)", () => {
    expect(parseOp({ op: "set_text", fingerprint: FP, value: "x" }).ok).toBe(false);
    expect(parseOp({ op: "set_attr", fingerprint: "label:4", name: "for", value: "email" }).ok).toBe(false);
    expect(parseOp({ op: "remove_attr", fingerprint: "button-name:2", name: "aria-hidden" }).ok).toBe(false);
    expect(parseOp({ op: "set_attr", fingerprint: FP, name: "style", value: "display:none" }).ok).toBe(false);
    expect(parseOp({ op: "set_attr", fingerprint: FP, name: "aria-hidden", value: "true" }).ok).toBe(false);
  });

  it("is strict: unknown keys (html, selector, ordinal, verified) are rejected", () => {
    for (const extra of ["html", "selector", "ordinal", "verified", "url"]) {
      const op = { op: "set_attr", fingerprint: FP, name: "alt", value: "Shoe", [extra]: "x" };
      expect(parseOp(op).ok, extra).toBe(false);
    }
    expect(parseProposal({ ops: [VALID_OPS[0]], note: "trust me" }).ok).toBe(false);
  });

  it("rejects an empty or whitespace-only set_attr alt with a machine reason; mark_decorative is the only empty-alt path", () => {
    for (const value of ["", "   ", "\u00A0", "\u200B"]) {
      const r = parseOp({ op: "set_attr", fingerprint: FP, name: "alt", value });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons).toContain(OP_SCHEMA_REASONS.emptyAlt);
    }
    expect(parseOp({ op: "mark_decorative", fingerprint: FP }).ok).toBe(true);
    expect(parseOp({ op: "mark_decorative", fingerprint: FP, value: "" }).ok).toBe(false);
  });

  it("only allows tabindex value \"0\"", () => {
    for (const value of ["1", "-1", "00", " 0", "0 ", "", "2"]) {
      const r = parseOp({ op: "set_attr", fingerprint: "tabindex:3", name: "tabindex", value });
      expect(r.ok, value).toBe(false);
      if (!r.ok) expect(r.reasons).toContain(OP_SCHEMA_REASONS.tabindexValue);
    }
  });

  it("bounds retag_heading level to integers 1..6", () => {
    for (const level of [0, 7, 2.5, -1, "3"]) {
      expect(parseOp({ op: "retag_heading", fingerprint: "heading-order:9", level }).ok, String(level)).toBe(false);
    }
  });

  it("requires a well-formed fingerprint on every op", () => {
    for (const fingerprint of ["", "image-alt", "image-alt:-1", "image-alt:01", "Image-Alt:1", "image alt:1", "#main > img", "image-alt:1:2"]) {
      expect(parseOp({ op: "mark_decorative", fingerprint }).ok, fingerprint).toBe(false);
    }
    expect(parseOp({ op: "mark_decorative" }).ok).toBe(false);
  });

  it("accepts 1-2 ops, rejects 0 and 3", () => {
    const a = { op: "set_style_color", fingerprint: "color-contrast:7", property: "color", value: "#000" };
    const b = { op: "set_style_color", fingerprint: "color-contrast:7", property: "background-color", value: "#fff" };
    expect(parseProposal({ ops: [a] }).ok).toBe(true);
    expect(parseProposal({ ops: [a, b] }).ok).toBe(true);
    expect(parseProposal({ ops: [] }).ok).toBe(false);
    expect(parseProposal({ ops: [a, b, a] }).ok).toBe(false);
  });

  it("rejects ops in one proposal that target different findings or the same attribute twice", () => {
    const r1 = parseProposal({
      ops: [
        { op: "set_attr", fingerprint: "button-name:4", name: "aria-label", value: "Search" },
        { op: "set_attr", fingerprint: "button-name:5", name: "title", value: "Search" },
      ],
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reasons).toContain(OP_SCHEMA_REASONS.fingerprintMismatch);

    const r2 = parseProposal({
      ops: [
        { op: "set_attr", fingerprint: FP, name: "alt", value: "Shoe" },
        { op: "mark_decorative", fingerprint: FP },
      ],
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reasons).toContain(OP_SCHEMA_REASONS.duplicateTarget);
  });

  it("parses the abstain shape and rejects mixed or blank abstains", () => {
    const r = parseProposal({ abstain: "no candidate text near the icon" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(isAbstain(r.value)).toBe(true);
    expect(parseProposal({ abstain: "" }).ok).toBe(false);
    expect(parseProposal({ abstain: "   " }).ok).toBe(false);
    expect(parseProposal({ abstain: "x", ops: [VALID_OPS[0]] }).ok).toBe(false);
    expect(parseProposal({ abstain: "x", extra: 1 }).ok).toBe(false);
  });

  it("rejects non-object payloads", () => {
    for (const input of [null, undefined, 42, "ops", [], [VALID_OPS[0]]]) expect(parseProposal(input).ok).toBe(false);
  });

  it("property: adding any unknown key to a valid op is always rejected", () => {
    const known = new Set(["op", "fingerprint", "name", "value", "property", "level", "text"]);
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_OPS),
        fc.string({ minLength: 1, maxLength: 12 }).filter((k) => !known.has(k) && k !== "__proto__"),
        fc.jsonValue(),
        (op, key, value) => {
          const withExtra = { ...(op as Record<string, unknown>), [key]: value };
          return parseOp(withExtra).ok === false;
        },
      ),
    );
  });

  it("property: arbitrary JSON never parses unless it is a well-formed proposal", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const r = parseProposal(value);
        if (!r.ok) return true;
        return "abstain" in r.value || ("ops" in r.value && r.value.ops.length >= 1 && r.value.ops.length <= 2);
      }),
    );
  });
});
