// Deterministic Mulberry32; no Math.random or wall clock enters corpus content.
export function createPrng(seed: number): () => number {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError("seed_must_be_uint32");
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    const a = copy[index]; const b = copy[other];
    if (a === undefined || b === undefined) throw new Error("shuffle_index_out_of_bounds");
    copy[index] = b; copy[other] = a;
  }
  return copy;
}
