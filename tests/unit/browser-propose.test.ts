// what_bug_this_catches: config crashes, missing/changed identity calls, unbounded stalled-body waits, redirect
// token leakage or retried provider hops. Mock public session/HTTP only, no browser/auth/network execution.
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BrowserBackend } from "../../src/app/lib/supabase.ts";
import { publicBackendConfig } from "../../src/app/lib/supabase.ts";
import { createBrowserTransport } from "../../src/app/lib/proposeClient.ts";
import { ProposeRequestSchema } from "../../src/shared/proposeRequest.ts";
import { MODEL_A } from "../../src/shared/providerConfig.ts";
import { buildContext } from "../../src/core/proposers/context.ts";
import { parsePage } from "../../src/core/html/parse.ts";
const target = { rule: "image-alt" as const, ordinal: 0, fingerprint: "image-alt:0" as const, impact: null, cite: null, unmappedReason: null, summary: null, contrast: null };
const request = () => ProposeRequestSchema.parse({ attemptId: "22222222-2222-4222-8222-222222222222", proposer: "llm-A", model: MODEL_A, finding: { rule: target.rule, ordinal: 0, fingerprint: target.fingerprint }, context: buildContext(parsePage("<img>"), target).context, retryReasons: [] });
function backend(expired = false): BrowserBackend {
  const session = { user: { id: "unit-user" }, access_token: "unit-public-session-jwt", expires_at: expired ? 1 : Date.now() / 1000 + 3600 };
  const client = { auth: { getSession: async () => ({ error: null, data: { session } }), refreshSession: async () => ({ error: null, data: { session: { ...session, access_token: "refreshed-unit-jwt" } } }) } } as unknown as SupabaseClient;
  return { client, url: "https://unit.supabase.co", publicKey: "unit-public-anon-key", error: null };
}
describe("browser remote transport", () => {
  it("handles missing/invalid public config without contacting a provider", () => {
    expect(publicBackendConfig({})).toBeNull(); expect(() => publicBackendConfig({ VITE_SUPABASE_URL: "javascript:bad()", VITE_SUPABASE_ANON_KEY: "public" })).toThrow();
  });
  it("refreshes JWT, sends one bounded nonredirecting hop and preserves the response envelope", async () => {
    let calls = 0;
    const invoke = createBrowserTransport(backend(true), async (_url, options) => { calls++; expect(options?.redirect).toBe("error"); expect(options?.headers).toMatchObject({ Authorization: "Bearer refreshed-unit-jwt", apikey: "unit-public-anon-key" }); return new Response(JSON.stringify({ kind: "error", code: "budget_exceeded" })); });
    expect(await invoke(request())).toMatchObject({ httpStatus: 200, body: { kind: "error", code: "budget_exceeded" } }); expect(calls).toBe(1);
  });
  it("does not call HTTP without a signed-in session and maps malformed/401 bodies explicitly", async () => {
    const absent = { ...backend(), client: { auth: { getSession: async () => ({ error: null, data: { session: null } }) } } as unknown as SupabaseClient };
    let calls = 0; expect(await createBrowserTransport(absent, async () => { calls++; return new Response(); })(request())).toEqual({ httpStatus: 401, body: null }); expect(calls).toBe(0);
    expect(await createBrowserTransport(backend(), async () => new Response("gateway", { status: 401 }))(request())).toEqual({ httpStatus: 401, body: null });
    expect(await createBrowserTransport(backend(), async () => new Response("not-json"))(request())).toEqual({ httpStatus: 200, body: null });
  });
  it("aborts a response reader that never resolves inside the35s deadline", async () => {
    vi.useFakeTimers();
    try { const pending = createBrowserTransport(backend(), async () => new Response(new ReadableStream<Uint8Array>({ start() {} })))(request());
      await vi.advanceTimersByTimeAsync(35001); expect(await pending).toMatchObject({ body: { kind: "error", code: "provider_timeout" } });
    } finally { vi.useRealTimers(); }
  });
});
