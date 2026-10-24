// Pure provider adapter: key arrives only as an edge-owned argument. No environment, SDK retries or logs.
export interface ProviderReply {
  readonly kind: "ok" | "error"; readonly value?: unknown; readonly inputTokens: number | null; readonly outputTokens: number | null;
  readonly code?: "provider_timeout" | "provider_error" | "rate_limited";
}
export type ProviderFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export async function callAnthropic(key: string, request: { model: string; system: string; prompt: string; signal: AbortSignal }, transport: ProviderFetch): Promise<ProviderReply> {
  try {
    const response = await transport("https://api.anthropic.com/v1/messages", { method: "POST", signal: request.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: request.model, max_tokens: 1024, temperature: 0, system: request.system, messages: [{ role: "user", content: request.prompt }] }) });
    if (!response.ok) return { kind: "error", code: response.status === 429 ? "rate_limited" : "provider_error", inputTokens: null, outputTokens: null };
    const text = await response.text(); if (text.length > 65536) throw new Error("provider_response_too_large");
    const body: unknown = JSON.parse(text);
    if (!record(body) || !Array.isArray(body["content"]) || !record(body["usage"])) throw new Error("provider_envelope_invalid");
    const input = body["usage"]["input_tokens"]; const output = body["usage"]["output_tokens"];
    if (typeof input !== "number" || !Number.isInteger(input) || input < 0 || input > 32768 || typeof output !== "number" || !Number.isInteger(output) || output < 0 || output > 1024) throw new Error("provider_usage_invalid");
    const content = body["content"].filter(record).filter((block) => block["type"] === "text" && typeof block["text"] === "string").map((block) => block["text"] as string).join("");
    let value: unknown = content; try { value = JSON.parse(content) as unknown; } catch { /* Malformed model JSON reaches the schema gate, with actual usage. */ }
    return { kind: "ok", value, inputTokens: input, outputTokens: output };
  } catch { return { kind: "error", code: request.signal.aborted ? "provider_timeout" : "provider_error", inputTokens: null, outputTokens: null }; }
}
