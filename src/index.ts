// Public pure/isomorphic entrypoint. Node/browser adapters stay outside this module's import graph.
import { runPage } from "./core/loop/runPage.ts";
import { runFix } from "./core/loop/runFix.ts";
import { strictGate } from "./core/gate/strict.ts";
import { targetOnlyGate, scoreDeltaGate, regionScopedGate } from "./core/gate/variants.ts";
import { combineFixes } from "./core/gate/combine.ts";

export type { Artifact, RunPageInput, RunPageResult } from "./core/loop/runPage.ts";
export type { RunFixInput } from "./core/loop/runFix.ts";
export type { Finding, AuditResult, AuditEngine } from "./core/audit/types.ts";
export type { Op } from "./shared/opsSchema.ts";
export type { FixResult, FixAttempt, FixState } from "./core/ledger/types.ts";
export type { FixProposer, ProposerResponse } from "./core/proposers/types.ts";
export { runPage, runFix, strictGate, targetOnlyGate, scoreDeltaGate, regionScopedGate, combineFixes };
export const verifiedfix = Object.freeze({ runPage, runFix, strictGate, targetOnlyGate, scoreDeltaGate, regionScopedGate, combineFixes });
