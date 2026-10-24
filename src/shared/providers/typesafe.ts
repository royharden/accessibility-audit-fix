// Official System One HTTP contract; output is selected/decided by code, not generated repair text.
import { z } from "../deps.ts";
import type { ProposeRequest } from "../proposeRequest.ts";
import type { JevPolicy } from "../typesafePlan.ts";
import { NOUL_QUESTIONS, typesafePlan } from "../typesafePlan.ts";
import type { ProviderReply } from "./anthropic.ts";
import type { JsonProviderFetch } from "./http.ts";
import { providerJson } from "./http.ts";
const Choice = z.object({ type: z.literal("choice"), choice: z.string(), confidence: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number().min(0).max(1)) }).strict();
const Noul = z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }).strict();
const Envelope = z.object({ answers: z.record(z.string(), z.unknown()), usage: z.object({ input_tokens: z.number().int().nonnegative().max(32768), output_tokens: z.number().int().nonnegative().max(1024) }).passthrough() }).passthrough();
export async function callTypesafe(key: string, request: ProposeRequest, policy: JevPolicy, signal: AbortSignal, transport: JsonProviderFetch): Promise<ProviderReply> {
  try {
    const plan = await typesafePlan(request, policy);
    const response = await providerJson("https://api.typesafe.ai/v1/systemone", { Authorization: `Bearer ${key}` }, plan.body, signal, transport);
    if (response.status < 200 || response.status >= 300) return { kind: "error", code: response.status === 429 ? "rate_limited" : "provider_error", inputTokens: null, outputTokens: null };
    const body = Envelope.safeParse(response.data); if (!body.success) throw new Error("bad_typesafe_envelope");
    const usage = { inputTokens: body.data.usage.input_tokens, outputTokens: body.data.usage.output_tokens };
    if (request.proposer === "jev-triage") {
      const scores = Object.entries(NOUL_QUESTIONS).map(([id]) => ({ id, answer: Noul.safeParse(body.data.answers[id]) }));
      if (scores.some((score) => !score.answer.success) || policy.routeAt === null || policy.rejectAt === null) return { kind: "ok", value: { invalid_noul_response: true }, ...usage };
      const reasons = scores.filter((score) => score.answer.success && score.answer.data.noul >= (policy.routeAt ?? 1)).map((score) => `jev:${score.id}`);
      const reject = scores.some((score) => score.answer.success && score.answer.data.noul >= (policy.rejectAt ?? 1));
      return { kind: "ok", value: { decision: reject ? "reject" : reasons.length > 0 ? "route" : "pass", reasons }, ...usage };
    }
    const answer = Choice.safeParse(body.data.answers["name"]);
    if (!answer.success || Object.keys(answer.data.probabilities).some((id) => id !== "none" && !plan.choices.some((choice) => choice.id === id))) return { kind: "ok", value: { invalid_choice_response: true }, ...usage };
    const choice = plan.choices.find((choice) => choice.id === answer.data.choice);
    if (answer.data.choice !== "none" && choice === undefined) return { kind: "ok", value: { invalid_choice_id: true }, ...usage };
    if (answer.data.choice === "none" || policy.choiceMinConfidence === null || answer.data.confidence < policy.choiceMinConfidence) return { kind: "ok", value: { abstain: answer.data.choice === "none" ? "jev_none" : "jev_low_confidence" }, ...usage };
    return { kind: "ok", value: { ops: [{ op: "set_attr", fingerprint: request.finding.fingerprint, name: "aria-label", value: choice?.value }] }, ...usage };
  } catch { return { kind: "error", code: signal.aborted ? "provider_timeout" : "provider_error", inputTokens: null, outputTokens: null }; }
}
