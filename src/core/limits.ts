// Limits (PLAN.md 2.1, 2.6, 3; CL 2.7-2.9). Constants that the edge function also needs are defined in src/shared
// and re-exported here, so each number has exactly one definition.
export { MAX_OPS_PER_PROPOSAL } from "../shared/opsSchema.ts";
export { MAX_NAME_LENGTH } from "../shared/valueGates.ts";

/** Input: UTF-8 encoded bytes (the UI says "200 KB"). The baseline audit is never truncated. */
export const MAX_INPUT_BYTES = 200_000;
export const MAX_INPUT_LABEL = "200 KB";

/** Proposal queue: first 50 eligible findings by (ordinal, rule id); the rest -> proposal_queue_truncated (n). */
export const MAX_PROPOSAL_QUEUE = 50;

/** Proposer context (aggregate and per-part caps). */
export const CONTEXT_MAX_BYTES = 4096;
export const CONTEXT_PARENT_CHUNK_MAX_CHARS = 1500;
export const CONTEXT_TARGET_TAG_MAX_CHARS = 500;

/** propose-fix request body cap. */
export const EDGE_BODY_MAX_BYTES = 16_384;
export const MAX_RETRY_REASONS = 10;

/** Retry: default 2 retries, at most 3 attempts per finding; first-pass and final reported separately. */
export const DEFAULT_RETRIES = 2;
export const MAX_ATTEMPTS = DEFAULT_RETRIES + 1;

/** Timeouts (ms). */
export const JSDOM_AUDIT_TIMEOUT_MS = 10_000;
export const IFRAME_AUDIT_TIMEOUT_MS = 15_000;
export const PROVIDER_TIMEOUT_MS = 20_000;
export const EDGE_OVERALL_TIMEOUT_MS = 30_000;

/** iframe runner postMessage payload cap. */
export const IFRAME_MESSAGE_MAX_BYTES = 2 * 1024 * 1024;

/** rulings.note check (char_length <= 500). */
export const RULING_NOTE_MAX_CHARS = 500;

/** Eval CLI concurrency for remote proposers. */
export const EVAL_MAX_CONCURRENCY = 2;

/**
 * UTF-8 encoded length without TextEncoder or Buffer (src/core stays free of runtime globals).
 * A lone surrogate counts 3 bytes, as TextEncoder encodes it as U+FFFD.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

export function isWithinInputLimit(text: string): boolean {
  return utf8ByteLength(text) <= MAX_INPUT_BYTES;
}
