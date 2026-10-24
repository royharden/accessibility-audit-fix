import { z } from "./deps.ts";
import { ELIGIBLE_RULE_IDS } from "./rules.ts";
import { FINGERPRINT_PATTERN } from "./opsSchema.ts";
import { METHOD_IDS } from "./providerConfig.ts";
export const SCHEMA_VERSION = "s28-ops-v1";
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ContextSchema = z.object({
  rule: z.string().max(100), ordinal: z.number().int().nonnegative().max(999999999).nullable(), tagName: z.string().max(100).nullable(),
  targetTag: z.string().max(500), parentChunk: z.string().max(1500), precedingHeading: z.string().max(200),
  previousHeadingLevel: z.number().int().min(1).max(6).nullable(), firstH1: z.string().max(125), fileTitle: z.string().max(125), summary: z.string().max(300),
  candidates: z.array(z.object({ source: z.enum(["inner", "title", "placeholder", "value", "image-stem", "label"]), value: z.string().max(125) }).strict()).max(8),
  contrast: z.object({ fgColor: z.string().max(80).nullable(), bgColor: z.string().max(80).nullable(), contrastRatio: z.number().finite().nullable(),
    expectedContrastRatio: z.string().max(40).nullable(), fontSize: z.string().max(40).nullable(), fontWeight: z.string().max(40).nullable() }).strict().nullable(),
  tabindex: z.string().max(40).nullable(), focusability: z.enum(["focusable", "not_focusable", "undecidable"]), screened: z.boolean(),
  // Optional bounded ID evidence; absent evidence makes server aria-labelledby value validation abstain/fail closed.
  ids: z.array(z.object({ id: z.string().min(1).max(100), count: z.number().int().positive() }).strict()).max(20).optional(),
  targetId: z.string().max(100).nullable().optional(),
}).strict();
type DeepReadonly<T> = T extends readonly (infer V)[] ? readonly DeepReadonly<V>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type PromptContext = DeepReadonly<z.infer<typeof ContextSchema>>;
export const ProposeRequestSchema = z.object({
  attemptId: z.string().regex(UUID_PATTERN), proposer: z.enum(METHOD_IDS), model: z.string().min(1).max(120),
  finding: z.object({ rule: z.enum(ELIGIBLE_RULE_IDS), ordinal: z.number().int().nonnegative().max(999999999), fingerprint: z.string().regex(FINGERPRINT_PATTERN) }).strict(),
  context: ContextSchema, retryReasons: z.array(z.string().max(200)).max(10), runKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/).optional(),
}).strict().superRefine((request, ctx) => {
  if (request.finding.fingerprint !== `${request.finding.rule}:${request.finding.ordinal}` || request.context.rule !== request.finding.rule || request.context.ordinal !== request.finding.ordinal) ctx.addIssue({ code: "custom", message: "finding_context_identity_mismatch" });
});
export type ProposeRequest = z.infer<typeof ProposeRequestSchema>;
