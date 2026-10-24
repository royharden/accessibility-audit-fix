import type { ProposeRequest } from "./proposeRequest.ts";
import { METHODS } from "./providerConfig.ts";
/** Canonical JSON: recursively sorted object keys, array order retained; non-JSON/non-finite inputs refuse. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non_json_number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("non_json_value");
}
export type HashText = (text: string) => Promise<string>;
/** Web Crypto is available in the Node/Deno/browser adapters; no keys or environment are read here. */
export async function sha256Text(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** The only canonical request-binding field list (PLAN3). Context hash is pre-server-screen. */
export async function requestHashes(uid: string, request: ProposeRequest, hash: HashText = sha256Text) {
  const contextSha256 = await hash(canonicalJson(request.context));
  const requestSha256 = await hash(canonicalJson({ uid, provider: METHODS[request.proposer].provider, model: request.model,
    proposer: request.proposer, rule: request.finding.rule, fingerprint: request.finding.fingerprint, contextSha256,
    retryReasons: request.retryReasons, runKey: request.runKey ?? null }));
  return { contextSha256, requestSha256 };
}
