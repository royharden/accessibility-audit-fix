// Node-only, activation-time operator login. No credentials or tokens are read from files or persisted.
import { StringDecoder } from "node:string_decoder";
import { createClient } from "@supabase/supabase-js";
import type { ProposeRequest } from "../shared/proposeRequest.ts";

export interface OperatorSession {
  readonly userId: string;
  invoke(request: ProposeRequest): Promise<{ httpStatus: number; body: unknown }>;
  readOwnCall(attemptId: string): Promise<unknown | null>;
  close(): Promise<void>;
}

/** Password goes from a hidden interactive TTY directly into memory, never env, file, argument, or log. */
function hiddenPassword(): Promise<string> {
  const input = process.stdin; const output = process.stdout;
  if (!input.isTTY || !output.isTTY) return Promise.reject(new Error("operator_password_requires_interactive_tty"));
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw; const wasFlowing = input.readableFlowing;
    const decoder = new StringDecoder("utf8");
    let value = ""; let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      input.off("data", onData); input.off("error", onError); input.off("end", onEnd);
      try { input.setRawMode(wasRaw); } catch { /* Closed TTY; never log password data. */ }
      if (wasFlowing !== true) input.pause();
      output.write("\n");
      const password = value; value = "";
      if (error !== undefined) reject(error);
      else if (password.length === 0) reject(new Error("operator_password_empty"));
      else resolve(password);
    };
    const onError = (): void => finish(new Error("operator_password_input_failed"));
    const onEnd = (): void => finish(new Error("operator_password_input_ended"));
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      // Ignore terminal navigation escape sequences; never echo even a masked password length.
      if (text.startsWith("\u001b")) return;
      for (const character of text) {
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u0003" || character === "\u0004") { finish(new Error("operator_login_cancelled")); return; }
        if (character === "\b" || character === "\u007f") value = Array.from(value).slice(0, -1).join("");
        else if ((character.codePointAt(0) ?? 0) >= 32) value += character;
        if (value.length > 4096) { finish(new Error("operator_password_too_long")); return; }
      }
    };
    output.write("Operator password (hidden): ");
    input.setRawMode(true);
    input.on("data", onData); input.once("error", onError); input.once("end", onEnd); input.resume();
  });
}

const boundedFetch: typeof fetch = (input, init = {}) => {
  const timeout = AbortSignal.timeout(35000);
  const signal = init.signal === undefined || init.signal === null ? timeout : AbortSignal.any([init.signal, timeout]);
  return fetch(input, { ...init, signal });
};
async function responseJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 262144) { await reader.cancel(); throw new Error("operator_response_too_large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { return null; } // Caller validates the response union; gateway401 is classified by HTTP status first.
}

export async function openOperatorSession(): Promise<OperatorSession> {
  // This is the complete configuration read set. In particular, there are no CLI provider/service-role keys.
  const rawUrl = process.env["VITE_SUPABASE_URL"];
  const publicKey = process.env["VITE_SUPABASE_ANON_KEY"];
  const email = process.env["S28_OPERATOR_EMAIL"]?.trim();
  if (!rawUrl || !publicKey || !email) throw new Error("operator_public_config_or_email_missing");
  const url = new URL(rawUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password ||
    url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("invalid_operator_backend_url");
  const client = createClient(url.origin, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: boundedFetch },
  });
  let password = await hiddenPassword();
  let userId: string;
  try {
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error !== null || signed.data.user === null || signed.data.session === null) throw new Error("operator_sign_in_failed");
    userId = signed.data.user.id;
  } finally { password = ""; }
  let closed = false;
  let refresh: Promise<string> | null = null;
  const accessToken = async (): Promise<string> => {
    if (closed) throw new Error("operator_session_closed");
    const current = await client.auth.getSession();
    const session = current.data.session;
    if (current.error !== null || session === null || session.user.id !== userId) throw new Error("operator_session_unavailable");
    if (session.expires_at !== undefined && session.expires_at * 1000 > Date.now() + 60000) return session.access_token;
    if (refresh === null) refresh = client.auth.refreshSession().then((result) => {
      if (result.error !== null || result.data.session === null || result.data.session.user.id !== userId) throw new Error("operator_session_refresh_failed");
      return result.data.session.access_token;
    }).finally(() => { refresh = null; });
    return refresh;
  };
  return {
    userId,
    async invoke(request) {
      const token = await accessToken();
      const response = await boundedFetch(new URL("/functions/v1/propose-fix", url.origin), {
        method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: publicKey, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      return { httpStatus: response.status, body: await responseJson(response) };
    },
    async readOwnCall(attemptId) {
      await accessToken();
      const result = await client.from("llm_calls").select("*").eq("user_id", userId).eq("attempt_id", attemptId).maybeSingle();
      if (result.error !== null) throw new Error("operator_ledger_read_failed");
      return result.data as unknown | null;
    },
    async close() {
      if (closed) return;
      closed = true; client.auth.stopAutoRefresh();
      const result = await client.auth.signOut({ scope: "local" });
      if (result.error !== null) throw new Error("operator_local_sign_out_failed");
    },
  };
}
