// Canonical fix-op schema (PLAN.md 2.3, CL 2.5). Edge-copied byte-identically.
// A proposal is either {"ops": [1..2 ops]} or {"abstain": reason}. Every op is a .strict() object (unknown keys
// rejected) inside a zod discriminated union on "op", and every op carries the finding fingerprint. The model
// never emits HTML, diffs, selectors, URLs or scripts. Content checks live in valueGates.ts, the per-rule matrix
// in ruleOps.ts; contextual preconditions (natively focusable, existing <title>, matching end tag) are resolved
// by code in src/core/ops/resolve.ts (M2).
import { z } from "./deps.ts";

export const MAX_OPS_PER_PROPOSAL = 2;
/** Hard payload cap per string field; the value gates apply the real 125-character name limit. */
export const MAX_OP_STRING_LENGTH = 1000;
export const MAX_ABSTAIN_REASON_LENGTH = 500;
export const MAX_FINGERPRINT_LENGTH = 80;

/** `rule_id:ordinal`, ordinal a non-negative decimal integer without leading zeros. */
export const FINGERPRINT_PATTERN = /^[a-z][a-z0-9-]{0,63}:(?:0|[1-9][0-9]{0,8})$/;

export const SET_ATTR_NAMES = ["alt", "aria-label", "aria-labelledby", "lang", "title", "tabindex"] as const;
export type SetAttrName = (typeof SET_ATTR_NAMES)[number];

export const REMOVE_ATTR_NAMES = ["tabindex"] as const;
export type RemoveAttrName = (typeof REMOVE_ATTR_NAMES)[number];

export const STYLE_COLOR_PROPERTIES = ["color", "background-color"] as const;
export type StyleColorProperty = (typeof STYLE_COLOR_PROPERTIES)[number];

export const OP_KINDS = [
  "set_attr",
  "remove_attr",
  "set_style_color",
  "retag_heading",
  "set_document_title",
  "mark_decorative",
] as const;
export type OpKind = (typeof OP_KINDS)[number];

/** The only value `set_attr tabindex` may write (explicit whitelist extension C3). */
export const TABINDEX_SET_VALUE = "0";

/** Machine reason codes raised by schema refinements (custom zod issues carry these as their message). */
export const OP_SCHEMA_REASONS = {
  emptyAlt: "set_attr_alt_empty_use_mark_decorative",
  tabindexValue: "set_attr_tabindex_must_be_0",
  fingerprintMismatch: "ops_fingerprint_mismatch",
  duplicateTarget: "duplicate_op_target",
  blankAbstain: "abstain_reason_blank",
} as const;

const INVISIBLE_CHARS = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;

/** True when the text is empty after removing invisible format characters and trimming whitespace. */
export function isBlankText(value: string): boolean {
  return value.replace(INVISIBLE_CHARS, "").trim() === "";
}

const FingerprintSchema = z.string().max(MAX_FINGERPRINT_LENGTH).regex(FINGERPRINT_PATTERN);
const OpStringSchema = z.string().max(MAX_OP_STRING_LENGTH);

export const SetAttrOpSchema = z
  .object({
    op: z.literal("set_attr"),
    fingerprint: FingerprintSchema,
    name: z.enum(SET_ATTR_NAMES),
    value: OpStringSchema,
  })
  .strict();

export const RemoveAttrOpSchema = z
  .object({
    op: z.literal("remove_attr"),
    fingerprint: FingerprintSchema,
    name: z.enum(REMOVE_ATTR_NAMES),
  })
  .strict();

export const SetStyleColorOpSchema = z
  .object({
    op: z.literal("set_style_color"),
    fingerprint: FingerprintSchema,
    property: z.enum(STYLE_COLOR_PROPERTIES),
    value: OpStringSchema,
  })
  .strict();

export const RetagHeadingOpSchema = z
  .object({
    op: z.literal("retag_heading"),
    fingerprint: FingerprintSchema,
    level: z.number().int().min(1).max(6),
  })
  .strict();

export const SetDocumentTitleOpSchema = z
  .object({
    op: z.literal("set_document_title"),
    fingerprint: FingerprintSchema,
    text: OpStringSchema,
  })
  .strict();

export const MarkDecorativeOpSchema = z
  .object({
    op: z.literal("mark_decorative"),
    fingerprint: FingerprintSchema,
  })
  .strict();

/** Structural union (no cross-field rules). Use OpSchema to validate. */
export const OpUnionSchema = z.discriminatedUnion("op", [
  SetAttrOpSchema,
  RemoveAttrOpSchema,
  SetStyleColorOpSchema,
  RetagHeadingOpSchema,
  SetDocumentTitleOpSchema,
  MarkDecorativeOpSchema,
]);

export type SetAttrOp = z.infer<typeof SetAttrOpSchema>;
export type RemoveAttrOp = z.infer<typeof RemoveAttrOpSchema>;
export type SetStyleColorOp = z.infer<typeof SetStyleColorOpSchema>;
export type RetagHeadingOp = z.infer<typeof RetagHeadingOpSchema>;
export type SetDocumentTitleOp = z.infer<typeof SetDocumentTitleOpSchema>;
export type MarkDecorativeOp = z.infer<typeof MarkDecorativeOpSchema>;
export type Op = z.infer<typeof OpUnionSchema>;

/** One op, with the per-op rules: `set_attr alt` cannot be empty (only mark_decorative writes alt=""), and
 * `set_attr tabindex` may only write "0". */
export const OpSchema = OpUnionSchema.superRefine((op, ctx) => {
  if (op.op !== "set_attr") return;
  if (op.name === "alt" && isBlankText(op.value)) {
    ctx.addIssue({ code: "custom", message: OP_SCHEMA_REASONS.emptyAlt, path: ["value"] });
  }
  if (op.name === "tabindex" && op.value !== TABINDEX_SET_VALUE) {
    ctx.addIssue({ code: "custom", message: OP_SCHEMA_REASONS.tabindexValue, path: ["value"] });
  }
});

/** The attribute / style property / tag / title that an op writes; two ops in one proposal may not share one. */
export function opTargetKey(op: Op): string {
  switch (op.op) {
    case "set_attr":
    case "remove_attr":
      return `attr:${op.name}`;
    case "mark_decorative":
      return "attr:alt";
    case "set_style_color":
      return `style:${op.property}`;
    case "retag_heading":
      return "tag";
    case "set_document_title":
      return "title";
  }
}

export const OpsProposalSchema = z
  .object({
    ops: z.array(OpSchema).min(1).max(MAX_OPS_PER_PROPOSAL),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    const fingerprints = new Set(proposal.ops.map((op) => op.fingerprint));
    if (fingerprints.size > 1) {
      ctx.addIssue({ code: "custom", message: OP_SCHEMA_REASONS.fingerprintMismatch, path: ["ops"] });
    }
    const keys = proposal.ops.map(opTargetKey);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: OP_SCHEMA_REASONS.duplicateTarget, path: ["ops"] });
    }
  });

export const AbstainProposalSchema = z
  .object({
    abstain: z.string().min(1).max(MAX_ABSTAIN_REASON_LENGTH),
  })
  .strict()
  .superRefine((proposal, ctx) => {
    if (isBlankText(proposal.abstain)) {
      ctx.addIssue({ code: "custom", message: OP_SCHEMA_REASONS.blankAbstain, path: ["abstain"] });
    }
  });

export const ProposalSchema = z.union([OpsProposalSchema, AbstainProposalSchema]);

export type OpsProposal = z.infer<typeof OpsProposalSchema>;
export type AbstainProposal = z.infer<typeof AbstainProposalSchema>;
export type Proposal = z.infer<typeof ProposalSchema>;

export type SchemaParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reasons: readonly string[] };

interface IssueLike {
  readonly code: string;
  readonly message: string;
  readonly path: readonly PropertyKey[];
}

/** Custom issues keep their machine reason; structural issues become `schema_invalid:<path>:<zod code>`. */
function issueReasons(issues: readonly IssueLike[]): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    const reason =
      issue.code === "custom"
        ? issue.message
        : `schema_invalid:${issue.path.map((p) => String(p)).join(".") || "$"}:${issue.code}`;
    if (!out.includes(reason)) out.push(reason);
  }
  return out.length > 0 ? out : ["schema_invalid"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOp(input: unknown): SchemaParseResult<Op> {
  const r = OpSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, reasons: issueReasons(r.error.issues) };
}

/**
 * Parses a proposer's output. Dispatches on the top-level key so that refinement reasons of the chosen branch
 * are reported (a plain z.union would bury them in an invalid_union issue). An object carrying both "ops" and
 * "abstain" is parsed as an ops proposal and fails .strict().
 */
export function parseProposal(input: unknown): SchemaParseResult<Proposal> {
  if (isRecord(input) && Object.hasOwn(input, "abstain") && !Object.hasOwn(input, "ops")) {
    const r = AbstainProposalSchema.safeParse(input);
    return r.success ? { ok: true, value: r.data } : { ok: false, reasons: issueReasons(r.error.issues) };
  }
  const r = OpsProposalSchema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, reasons: issueReasons(r.error.issues) };
}

export function isAbstain(proposal: Proposal): proposal is AbstainProposal {
  return "abstain" in proposal;
}
