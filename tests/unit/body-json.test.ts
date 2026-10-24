// what_bug_this_catches: a stalled authenticated request body outliving the overall deadline, awaiting an
// unbounded cancel(), or retaining abort listeners/reader locks after success, failure or cancellation.
// Written in Dirty Mode, never run. No Deno handler, HTTP, auth, database or provider is executed here.
import { describe, expect, it, vi } from "vitest";
import type { BodyRequest, ByteReader } from "../../src/shared/bodyJson.ts";
import { readBoundedBodyJson } from "../../src/shared/bodyJson.ts";

function request(reader: ByteReader): BodyRequest {
  return { headers: { get: () => null }, body: { getReader: () => reader } };
}
describe("bounded body JSON and caller deadline", () => {
  it("rejects a stalled body at the overall deadline even when cancellation never settles", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let reads = 0; let cancelled = 0; let released = 0;
    const reader: ByteReader = {
      read() {
        reads++;
        return reads === 1 ? Promise.resolve({ done: false, value: new TextEncoder().encode('{"runKey":') }) : new Promise<never>(() => {});
      },
      cancel() { cancelled++; return new Promise<never>(() => {}); },
      releaseLock() { released++; },
    };
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const pending = readBoundedBodyJson(request(reader), controller.signal, 16384);
      const rejected = expect(pending).rejects.toThrow("provider_timeout");
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(2);
      await vi.advanceTimersByTimeAsync(30000);
      await rejected;
      expect(cancelled).toBe(1); expect(released).toBe(1);
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
    } finally { clearTimeout(timer); vi.restoreAllMocks(); vi.useRealTimers(); }
  });
  it("does not acquire a reader when the overall signal is already aborted", async () => {
    const controller = new AbortController(); controller.abort(); let acquired = false;
    const body: BodyRequest = { headers: { get: () => null }, body: { getReader() { acquired = true; throw new Error("must_not_acquire"); } } };
    await expect(readBoundedBodyJson(body, controller.signal, 16384)).rejects.toThrow("provider_timeout");
    expect(acquired).toBe(false);
  });
  it("releases a completed reader and removes its abort listener without cancelling success", async () => {
    const controller = new AbortController(); let reads = 0; let cancelled = 0; let released = 0;
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const reader: ByteReader = {
      async read() { return ++reads === 1 ? { done: false, value: new TextEncoder().encode('{"ok":true}') } : { done: true }; },
      async cancel() { cancelled++; }, releaseLock() { released++; },
    };
    try {
      await expect(readBoundedBodyJson(request(reader), controller.signal, 16384)).resolves.toEqual({ ok: true });
      expect(cancelled).toBe(0); expect(released).toBe(1); expect(remove).toHaveBeenCalledOnce();
    } finally { vi.restoreAllMocks(); }
  });
  it("rejects oversized streamed bytes without waiting for a stalled cancellation", async () => {
    let cancelled = 0; let released = 0;
    const reader: ByteReader = {
      async read() { return { done: false, value: new Uint8Array(16385) }; },
      cancel() { cancelled++; return new Promise<never>(() => {}); }, releaseLock() { released++; },
    };
    await expect(readBoundedBodyJson(request(reader), new AbortController().signal, 16384)).rejects.toThrow("payload_too_large");
    expect(cancelled).toBe(1); expect(released).toBe(1);
  });
});
