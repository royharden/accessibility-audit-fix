// Finding fingerprint = `rule_id:ordinal` (PLAN.md 2.2): never a CSS selector. Ordinals are preorder ordinals of
// source-located elements in the unpatched parse; page-level rules use the <html> ordinal. Elements without an
// ordinal (implied, parse-recovery clones, unmapped axe nodes) have no fingerprint.
import { FINGERPRINT_PATTERN } from "../../shared/opsSchema.ts";

export type Fingerprint = `${string}:${number}`;

export interface FingerprintParts {
  readonly rule: string;
  readonly ordinal: number;
}

const RULE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isValidOrdinal(ordinal: number): boolean {
  return Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal <= 999_999_999;
}

export function formatFingerprint(rule: string, ordinal: number): Fingerprint {
  if (!RULE_ID_PATTERN.test(rule)) throw new RangeError(`invalid rule id for fingerprint: ${JSON.stringify(rule)}`);
  if (!isValidOrdinal(ordinal)) throw new RangeError(`invalid ordinal for fingerprint: ${String(ordinal)}`);
  return `${rule}:${ordinal}`;
}

export function isFingerprint(value: unknown): value is Fingerprint {
  return typeof value === "string" && FINGERPRINT_PATTERN.test(value);
}

export function parseFingerprint(value: string): FingerprintParts | null {
  if (!isFingerprint(value)) return null;
  const colon = value.lastIndexOf(":");
  const ordinal = Number(value.slice(colon + 1));
  if (!isValidOrdinal(ordinal)) return null;
  return { rule: value.slice(0, colon), ordinal };
}

/** Total order used for the proposal queue: (ordinal, rule id). */
export function compareFingerprintParts(a: FingerprintParts, b: FingerprintParts): number {
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
}
