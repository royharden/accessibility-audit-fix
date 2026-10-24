import type { FixProposer } from "../../core/proposers/types.ts";
import { createRemoteProposer } from "../../core/proposers/remote.ts";
import type { MethodId } from "../../shared/providerConfig.ts";
import type { ProposeRequest } from "../../shared/proposeRequest.ts";
import { readBoundedBodyJson } from "../../shared/bodyJson.ts";
import { utf8ByteLength } from "../../core/limits.ts";
import type { BrowserBackend } from "./supabase.ts";
function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = ((bytes[6] ?? 0) & 15) | 64; bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("provider_timeout");
  let cancel = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(new Error("provider_timeout")); });
  signal.addEventListener("abort", cancel, { once: true });
  try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener("abort", cancel); }
}
/** Injectable single HTTP hop; auth waits and streamed response reads share the same deadline. */
export function createBrowserTransport(backend: BrowserBackend, transport: typeof fetch = fetch) {
  let boundUid: string | null = null;
  return async (request: ProposeRequest): Promise<{ httpStatus: number; body: unknown }> => {
    if (backend.client === null || backend.url === null || backend.publicKey === null) return { httpStatus: 200, body: { kind: "error", code: "provider_not_configured" } };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 35000);
    try {
      const current = await abortable(backend.client.auth.getSession(), controller.signal); let session = current.data.session;
      if (current.error !== null || session === null) return { httpStatus: 401, body: null };
      boundUid ??= session.user.id; if (session.user.id !== boundUid) return { httpStatus: 401, body: null };
      if (session.expires_at === undefined || session.expires_at * 1000 <= Date.now() + 60000) {
        const refreshed = await abortable(backend.client.auth.refreshSession(), controller.signal); session = refreshed.data.session;
        if (refreshed.error !== null || session === null || session.user.id !== boundUid) return { httpStatus: 401, body: null };
      }
      const body = JSON.stringify(request); if (utf8ByteLength(body) > 16384) return { httpStatus: 200, body: { kind: "error", code: "payload_too_large" } };
      const response = await abortable(transport(new URL("/functions/v1/propose-fix", backend.url), { method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: backend.publicKey, "Content-Type": "application/json" }, body }), controller.signal);
      if (response.status === 401) { try { void response.body?.cancel().catch(() => {}); } catch { /* no body is required for gateway auth failure */ } return { httpStatus: 401, body: null }; }
      try { return { httpStatus: response.status, body: await readBoundedBodyJson(response, controller.signal, 65536) }; }
      catch (error) { if (controller.signal.aborted || (error instanceof Error && error.message === "provider_timeout")) return { httpStatus: 200, body: { kind: "error", code: "provider_timeout" } }; return { httpStatus: response.status, body: null }; }
    } catch (error) { return { httpStatus: 200, body: { kind: "error", code: controller.signal.aborted || (error instanceof Error && error.message === "provider_timeout") ? "provider_timeout" : "provider_error" } }; }
    finally { clearTimeout(timer); }
  };
}
export function createBrowserProposer(method: MethodId, backend: BrowserBackend): FixProposer {
  return createRemoteProposer({ proposer: method, attemptId: async () => uuid(), invoke: createBrowserTransport(backend) });
}
