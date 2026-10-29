// Hidden semantic truth. Imported only by Node evaluation/generation and tests, never proposers or gates.
import { z } from "../../src/shared/deps.ts";
import { ELIGIBLE_RULE_IDS } from "../../src/shared/rules.ts";
import type { RuleId } from "../../src/shared/rules.ts";

export interface GoldDefect {
  readonly rule: RuleId;
  readonly ordinal: number;
  readonly truth: {
    readonly language?: string;
    readonly decorative?: boolean;
    readonly keywords?: readonly string[];
    readonly headingLevel?: number;
    readonly tabindex?: string | null;
  };
  readonly mustPreserve: { readonly visibleBodyText: string; readonly handlerCount: number };
}
export interface GoldPage {
  readonly schemaVersion: 1;
  readonly pageId: string;
  readonly file: string;
  readonly family: string;
  readonly split: "dev" | "heldout";
  readonly sourceSha256: string;
  readonly defects: readonly GoldDefect[];
}
export const GoldDefectSchema = z.object({
  rule: z.enum(ELIGIBLE_RULE_IDS), ordinal: z.number().int().nonnegative(),
  truth: z.object({
    language: z.string().min(1).max(100).optional(), decorative: z.boolean().optional(),
    keywords: z.array(z.string().min(1).max(125)).min(1).max(20).optional(),
    headingLevel: z.number().int().min(1).max(6).optional(),
    tabindex: z.string().max(40).nullable().optional(),
  }).strict(),
  mustPreserve: z.object({ visibleBodyText: z.string().max(200000), handlerCount: z.number().int().nonnegative() }).strict(),
}).strict();
export const GoldPageSchema = z.object({
  schemaVersion: z.literal(1), pageId: z.string().min(1).max(100), file: z.string().min(1).max(300),
  family: z.string().min(1).max(100), split: z.enum(["dev", "heldout"]),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), defects: z.array(GoldDefectSchema).min(1).max(50),
}).strict();
