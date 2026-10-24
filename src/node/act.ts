// Explicit, pinned W3C ACT downloads only; never called by tests or eval automatically.
import { createHash } from "node:crypto";
import { z } from "../shared/deps.ts";
import { ELIGIBLE_RULE_IDS } from "../shared/rules.ts";
import { MAX_INPUT_BYTES } from "../core/limits.ts";

export const ActCaseSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), actRuleId: z.string().min(1).max(100),
  axeRule: z.enum(ELIGIBLE_RULE_IDS), expectation: z.enum(["passed", "failed"]), url: z.string().min(1).max(2000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const ActFetchManifestSchema = z.object({ schemaVersion: z.literal(1), cases: z.array(ActCaseSchema).min(1).max(50) }).strict();
export type ActCase = z.infer<typeof ActCaseSchema>;
export function validateActUrl(input: string): URL {
  const url = new URL(input);
  const prefixes = ["/WAI/standards-guidelines/act/", "/WAI/content-assets/wcag-act-rules/"];
  if (url.protocol !== "https:" || !["www.w3.org", "w3.org"].includes(url.hostname) || url.port !== "" ||
    url.username !== "" || url.password !== "" || !prefixes.some((prefix) => url.pathname.startsWith(prefix)) || url.hash !== "") throw new Error("act_url_not_allowlisted");
  return url;
}
export async function fetchPinnedActCase(entry: ActCase): Promise<{ source: string; finalUrl: string; sha256: string }> {
  let url = validateActUrl(entry.url);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { Accept: "text/html" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (location === null || redirects === 3) throw new Error("act_redirect_limit");
        url = validateActUrl(new URL(location, url).href); continue;
      }
      if (!response.ok || response.body === null) throw new Error("act_download_failed");
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_INPUT_BYTES)) { await response.body.cancel(); throw new Error("act_size_limit"); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_INPUT_BYTES) { await reader.cancel(); throw new Error("act_size_limit"); }
        chunks.push(chunk.value);
      }
      const bytes = Buffer.concat(chunks, length); const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== entry.sha256) throw new Error("act_sha256_mismatch");
      return { source: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), finalUrl: url.href, sha256 };
    }
    throw new Error("act_redirect_limit");
  } finally { clearTimeout(timeout); }
}
