// Stream parsing only; no auth, provider, database or runtime-specific imports. The caller owns the deadline.
export interface ByteReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}
export interface BodyRequest {
  readonly headers: { get(name: string): string | null };
  readonly body: { getReader(): ByteReader } | null;
}
/** Enforce both the byte cap and caller's overall abort, including when read/cancel never settle. */
export async function readBoundedBodyJson(request: BodyRequest, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  if (signal.aborted) throw new Error("provider_timeout");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("invalid_body_limit");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error("payload_too_large");
  const reader = request.body?.getReader();
  if (reader === undefined) throw new Error("bad_request");
  let abortRead = (): void => {};
  const interrupted = new Promise<never>((_resolve, reject) => { abortRead = () => reject(new Error("provider_timeout")); });
  // Also handle a synchronous reader failure after an already-delivered abort; no orphan rejection.
  void interrupted.catch(() => {});
  signal.addEventListener("abort", abortRead, { once: true });
  const chunks: Uint8Array[] = []; let size = 0; let complete = false;
  try {
    if (signal.aborted) abortRead();
    while (true) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (signal.aborted) throw new Error("provider_timeout");
      if (chunk.done) { complete = true; break; }
      if (chunk.value === undefined) throw new Error("bad_request");
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error("payload_too_large");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new Error("bad_request"); }
  } finally {
    signal.removeEventListener("abort", abortRead);
    if (!complete || signal.aborted) {
      // A hostile/stalled source may never finish cancel(). Request cancellation without extending the deadline.
      try { void reader.cancel().catch(() => {}); } catch { /* Preserve the original read/abort error. */ }
    }
    try { reader.releaseLock(); } catch { /* Do not mask the original error if a reader already released itself. */ }
  }
}
