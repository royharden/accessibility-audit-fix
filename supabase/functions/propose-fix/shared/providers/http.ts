import type { BodyRequest } from "../bodyJson.ts";
import { readBoundedBodyJson } from "../bodyJson.ts";
export type JsonProviderFetch = (url: string, options: { method: string; redirect: "error"; signal: AbortSignal; headers: Record<string, string>; body: string }) => Promise<BodyRequest & { status: number; ok: boolean }>;
export async function providerJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, transport: JsonProviderFetch) {
  const response = await transport(url, { method: "POST", redirect: "error", signal, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!response.ok) { try { void response.body?.getReader().cancel().catch(() => {}); } catch { /* no body required for HTTP failure */ } return { status: response.status, data: null }; }
  return { status: response.status, data: await readBoundedBodyJson(response, signal, 65536) };
}
