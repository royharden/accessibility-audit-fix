// Canonical eligible-rule list, buckets and engine availability (one truth; PLAN.md 2.4, CL 1.1 item 5).
// Edge-copied byte-identically: relative imports inside src/shared only, explicit .ts extensions.
// Every other axe rule is still audited (regressions, strict gate (b)) but reported "not attempted".

export const ELIGIBLE_RULE_IDS = [
  "html-has-lang",
  "document-title",
  "image-alt",
  "button-name",
  "link-name",
  "label",
  "frame-title",
  "heading-order",
  "tabindex",
  "color-contrast",
] as const;

export type RuleId = (typeof ELIGIBLE_RULE_IDS)[number];

/** mechanical fixes can reach `verified`; content fixes top out at `checked` (human review pending). */
export type Bucket = "mechanical" | "content";

export const ENGINE_IDS = ["jsdom", "iframe"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export interface RuleSpec {
  readonly id: RuleId;
  readonly bucket: Bucket;
  /** Engines on which the rule is measured. `color-contrast` needs real layout: iframe (UI) only. */
  readonly engines: readonly EngineId[];
  /** Reported by axe on `<html>`; fingerprint uses the `<html>` ordinal; region-scoped gate reports n/a. */
  readonly pageLevel: boolean;
}

/** Enabled explicitly for strict gate (d); not an eligible rule. `skipped_not_measured` under jsdom. */
export const LABEL_NAME_MISMATCH_RULE_ID = "label-content-name-mismatch";

const BOTH_ENGINES: readonly EngineId[] = Object.freeze(["jsdom", "iframe"] as const);
const IFRAME_ONLY: readonly EngineId[] = Object.freeze(["iframe"] as const);

function spec(id: RuleId, bucket: Bucket, engines: readonly EngineId[], pageLevel: boolean): RuleSpec {
  return Object.freeze({ id, bucket, engines, pageLevel });
}

const RULE_TABLE: Record<RuleId, RuleSpec> = {
  "html-has-lang": spec("html-has-lang", "mechanical", BOTH_ENGINES, true),
  "document-title": spec("document-title", "content", BOTH_ENGINES, true),
  "image-alt": spec("image-alt", "content", BOTH_ENGINES, false),
  "button-name": spec("button-name", "content", BOTH_ENGINES, false),
  "link-name": spec("link-name", "content", BOTH_ENGINES, false),
  label: spec("label", "content", BOTH_ENGINES, false),
  "frame-title": spec("frame-title", "content", BOTH_ENGINES, false),
  "heading-order": spec("heading-order", "mechanical", BOTH_ENGINES, false),
  tabindex: spec("tabindex", "mechanical", BOTH_ENGINES, false),
  "color-contrast": spec("color-contrast", "mechanical", IFRAME_ONLY, false),
};

export const RULES: Readonly<Record<RuleId, RuleSpec>> = Object.freeze(RULE_TABLE);

export function isEligibleRule(id: string): id is RuleId {
  return Object.hasOwn(RULES, id);
}

export function ruleSpec(id: RuleId): RuleSpec {
  return RULES[id];
}

export function bucketOf(id: RuleId): Bucket {
  return RULES[id].bucket;
}

export function isPageLevelRule(id: string): boolean {
  return isEligibleRule(id) && RULES[id].pageLevel;
}

export function isRuleMeasuredOn(id: RuleId, engine: EngineId): boolean {
  return RULES[id].engines.includes(engine);
}

export function eligibleRulesFor(engine: EngineId): readonly RuleId[] {
  return ELIGIBLE_RULE_IDS.filter((id) => RULES[id].engines.includes(engine));
}

export const MECHANICAL_RULE_IDS: readonly RuleId[] = Object.freeze(
  ELIGIBLE_RULE_IDS.filter((id) => RULES[id].bucket === "mechanical"),
);

export const CONTENT_RULE_IDS: readonly RuleId[] = Object.freeze(
  ELIGIBLE_RULE_IDS.filter((id) => RULES[id].bucket === "content"),
);
