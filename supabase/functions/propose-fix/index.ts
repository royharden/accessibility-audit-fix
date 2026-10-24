// Deno deployment entrypoint. Activation blocked until npm/model/price pins and Bolt provisioning are verified.
import { createClient } from "npm:@supabase/supabase-js@0.0.0-PIN-AT-ACTIVATION";
import { ProposeRequestSchema } from "./shared/proposeRequest.ts";
import { ProposeResponseSchema, LlmCallSchema, usageFromCall } from "./shared/proposeResponse.ts";
import { runEdgeProposal } from "./shared/edgeFlow.ts";
import { callAnthropic } from "./shared/providers/anthropic.ts";
import { SYSTEM_PROMPT, userPrompt } from "./shared/prompt.ts";
import { requestHashes } from "./shared/requestHash.ts";
import { z } from "./shared/deps.ts";
import { readBoundedBodyJson } from "./shared/bodyJson.ts";

const ClaimSchema = z.object({ call_id: z.string(), claim: z.enum(["new", "pending", "settled"]) }).strict();
Deno.serve(async (request: Request): Promise<Response> => {
  const origin = request.headers.get("origin");
  const allowed = new Set((Deno.env.get("CORS_ALLOWED_ORIGINS") ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  const cors: Record<string, string> = { Vary: "Origin" };
  if (origin !== null && allowed.has(origin)) cors["Access-Control-Allow-Origin"] = origin;
  const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (origin !== null && !allowed.has(origin)) return respond({ kind: "error", code: "bad_request" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  if (request.method !== "POST") return respond({ kind: "error", code: "bad_request" }, 405);
  const controller = new AbortController(); const deadline = Date.now() + 30000;
  const timer = setTimeout(() => controller.abort(), 30000);
  const cancel = () => controller.abort(); request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) cancel();
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: controller.signal });
  try {
    const url = Deno.env.get("SUPABASE_URL"); const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!url || !anon) return respond({ kind: "error", code: "provider_not_configured" });
    const authorization = request.headers.get("authorization");
    if (authorization === null || !/^Bearer\s+\S+$/i.test(authorization)) return respond({ kind: "error", code: "unauthorized" }, 401);
    const auth = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: authorization }, fetch: boundedFetch } });
    const verified = await auth.auth.getUser(authorization.replace(/^Bearer\s+/i, ""));
    if (verified.error !== null || verified.data.user === null) return respond({ kind: "error", code: "unauthorized" }, 401);
    // No service RPC/client exists before JWT verification above. A public anon key is not a user identity.
    const body = await readBoundedBodyJson(request, controller.signal, 16384); const parsed = ProposeRequestSchema.safeParse(body);
    if (!parsed.success) return respond({ kind: "error", code: "bad_request" }, 400);
    const input = parsed.data; const uid = verified.data.user.id;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!serviceKey) return respond({ kind: "error", code: "provider_not_configured" });
    const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } });
    const result = await runEdgeProposal(input, uid, {
      providerConfigured: input.proposer === "llm-A" && key !== undefined && key.trim() !== "",
      async hasEvalBudget(user, runKey) { const result = await service.rpc("has_eval_budget", { p_user_id: user, p_run_key: runKey }); if (result.error !== null) throw new Error(result.error.message); return result.data === true; },
      async reserve(args) { const result = await service.rpc("reserve_llm_call", args); if (result.error !== null) throw new Error(result.error.message); return ClaimSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data); },
      async settle(id, status, inputTokens, outputTokens) { const result = await service.rpc("settle_llm_call", { p_call_id: id, p_status: status, p_input_tokens: inputTokens, p_output_tokens: outputTokens }); if (result.error !== null) throw new Error(result.error.message); },
      async usage(id) { const result = await service.from("llm_calls").select("*").eq("id", id).eq("user_id", uid).single(); if (result.error !== null) throw new Error("usage_read_failed"); return usageFromCall(LlmCallSchema.parse(result.data)); },
      async call(value) {
        const provider = new AbortController(); const abort = () => provider.abort(); controller.signal.addEventListener("abort", abort, { once: true });
        const remaining = Math.max(0, Math.min(20000, deadline - Date.now() - 5000));
        const timeout = setTimeout(abort, remaining); if (remaining === 0 || controller.signal.aborted) provider.abort();
        try { return await callAnthropic(key ?? "", { model: value.model, system: SYSTEM_PROMPT, prompt: userPrompt(value), signal: provider.signal }, fetch); }
        finally { clearTimeout(timeout); controller.signal.removeEventListener("abort", abort); }
      },
    });
    const hashes = await requestHashes(uid, input);
    console.info(JSON.stringify({ context_sha256: hashes.contextSha256, request_sha256: hashes.requestSha256, status: result.kind }));
    return respond(ProposeResponseSchema.parse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = message === "payload_too_large" ? "payload_too_large" : message === "bad_request" ? "bad_request" : controller.signal.aborted ? "provider_timeout" : "provider_error";
    return respond({ kind: "error", code }, code === "payload_too_large" ? 413 : code === "bad_request" ? 400 : 200);
  } finally { clearTimeout(timer); request.signal.removeEventListener("abort", cancel); }
});
