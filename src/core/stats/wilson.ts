export interface Rate {
  readonly numerator: number | null; readonly denominator: number; readonly value: number | null;
  readonly low: number | null; readonly high: number | null; readonly smallN: boolean;
}
/** Two-sided 95% Wilson score interval, without a continuity correction. n=0 is n/a. */
export function wilson(successes: number, total: number): Rate {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(successes) || total < 0 || successes < 0 || successes > total) throw new RangeError("invalid_rate_counts");
  if (total === 0) return { numerator: 0, denominator: 0, value: null, low: null, high: null, smallN: true };
  const z = 1.959963984540054; const z2 = z * z; const p = successes / total;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denominator;
  return { numerator: successes, denominator: total, value: p, low: Math.max(0, center - margin), high: Math.min(1, center + margin), smallN: total < 10 };
}
export function unknownRate(total: number): Rate { return { numerator: null, denominator: total, value: null, low: null, high: null, smallN: total < 10 }; }
