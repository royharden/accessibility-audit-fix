// Shared method identity; SQL price activation is an independent fail-closed server gate.
export const METHOD_IDS = ["llm-A", "llm-B", "jev-choice", "jev-triage"] as const;
export type MethodId = (typeof METHOD_IDS)[number];
export const MODEL_A = "MODEL-A-PIN-AT-ACTIVATION";
export const MODEL_B = "MODEL-B-PIN-AT-ACTIVATION";
export const MODEL_JEV = "jev-1.13.0";
export const METHODS = {
  "llm-A": { provider: "anthropic", model: MODEL_A, implemented: true },
  "llm-B": { provider: "openai-compatible", model: MODEL_B, implemented: true },
  "jev-choice": { provider: "typesafe", model: MODEL_JEV, implemented: true },
  "jev-triage": { provider: "typesafe", model: MODEL_JEV, implemented: true },
} as const;
export function isPinnedMethod(method: MethodId): boolean {
  return METHODS[method].implemented && !METHODS[method].model.includes("PIN-AT-ACTIVATION");
}
