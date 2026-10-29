import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
export interface BrowserBackend { readonly client: SupabaseClient | null; readonly url: string | null; readonly publicKey: string | null; readonly error: string | null }
export function publicBackendConfig(env: Record<string, unknown>): { url: string; publicKey: string } | null {
  const url = env["VITE_SUPABASE_URL"]; const key = env["VITE_SUPABASE_ANON_KEY"];
  if (typeof url !== "string" || typeof key !== "string" || url.trim() === "" || key.trim() === "") return null;
  const parsed = new URL(url);
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))) throw new Error("invalid_supabase_url");
  return { url: parsed.href.replace(/\/$/, ""), publicKey: key.trim() };
}
function initialize(): BrowserBackend {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env ?? {};
  try {
    const config = publicBackendConfig(env);
    if (config === null) return { client: null, url: null, publicKey: null, error: "missing_config" };
    return { ...config, client: createClient(config.url, config.publicKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }), error: null };
  } catch { return { client: null, url: null, publicKey: null, error: "invalid_config" }; }
}
/** Main owns explicit sign-in; a configured SDK may restore/refresh a previously persisted browser session. */
export const backend: BrowserBackend = initialize();
