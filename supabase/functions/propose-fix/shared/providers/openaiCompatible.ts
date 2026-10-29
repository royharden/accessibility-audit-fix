// Pure server adapter. Only the edge reads the key/base setting. No redirects, retries or arbitrary endpoints.
import type { ProviderReply } from "./anthropic.ts";
import type { JsonProviderFetch } from "./http.ts";
import { providerJson } from "./http.ts";
export const COMPATIBLE_BASES = ["https://api.openai.com/v1"] as const;
export function compatibleEndpoint(base: string): string {
  const url = new URL(base); const normalized = url.href.replace(/\/$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !COMPATIBLE_BASES.some((allowed) => allowed === normalized)) throw new Error("provider_not_configured");
  return `${normalized}/chat/completions`;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export async function callOpenaiCompatible(key: string, base: string, request: { model: string; system: string; prompt: string; signal: AbortSignal }, transport: JsonProviderFetch): Promise<ProviderReply> {
  try {
    const response = await providerJson(compatibleEndpoint(base), { Authorization: `Bearer ${key}` }, { model: request.model, stream: false, n: 1, max_completion_tokens: 1024,
      messages: [{ role: "system", content: request.system }, { role: "user", content: request.prompt }] }, request.signal, transport);
    if (response.status < 200 || response.status >= 300) return { kind: "error", code: response.status === 429 ? "rate_limited" : "provider_error", inputTokens: null, outputTokens: null };
    const body = response.data;
    if (!record(body) || !Array.isArray(body["choices"]) || !record(body["usage"])) throw new Error("bad_provider_envelope");
    const input = body["usage"]["prompt_tokens"]; const output = body["usage"]["completion_tokens"];
    if (typeof input !== "number" || !Number.isInteger(input) || input < 0 || input > 32768 || typeof output !== "number" || !Number.isInteger(output) || output < 0 || output > 1024) throw new Error("bad_provider_usage");
    const first = body["choices"][0]; const message = record(first) ? first["message"] : null;
    const content = record(message) ? message["content"] : null;
    if (typeof content !== "string") return { kind: "ok", value: { abstain: "provider_refusal_or_empty_content" }, inputTokens: input, outputTokens: output };
    let value: unknown = content; try { value = JSON.parse(content) as unknown; } catch { /* actual usage retained; schema gate rejects malformed model JSON */ }
    return { kind: "ok", value, inputTokens: input, outputTokens: output };
  } catch { return { kind: "error", code: request.signal.aborted ? "provider_timeout" : "provider_error", inputTokens: null, outputTokens: null }; }
}
