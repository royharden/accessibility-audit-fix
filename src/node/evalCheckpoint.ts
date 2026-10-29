import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "../shared/deps.ts";
import type { ProposeRequest } from "../shared/proposeRequest.ts";
import { UUID_PATTERN, SCHEMA_VERSION } from "../shared/proposeRequest.ts";
import { PROMPT_VERSION } from "../shared/prompt.ts";
import { canonicalJson, requestHashes, sha256Text } from "../shared/requestHash.ts";
import { LlmCallSchema, ProposeResponseSchema, usageFromCall } from "../shared/proposeResponse.ts";
import type { ProposeResponse, LlmCall } from "../shared/proposeResponse.ts";
import type { OperatorSession } from "./operatorSession.ts";
import { FsLedger } from "./fsLedger.ts";

const CheckpointSchema = z.object({ attemptId: z.string().regex(UUID_PATTERN), requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["started", "completed", "lost"]), response: ProposeResponseSchema.nullable() }).strict().superRefine((entry, ctx) => {
  if ((entry.phase === "completed") !== (entry.response !== null)) ctx.addIssue({ code: "custom", message: "checkpoint_phase_response_mismatch" });
});
export type CheckpointEntry = z.infer<typeof CheckpointSchema>;
export class EvalCheckpoint {
  private readonly entries = new Map<string, CheckpointEntry>();
  private writes: Promise<void> = Promise.resolve();
  readonly file: string;
  constructor(file: string) { this.file = file; }
  async load(): Promise<void> {
    let text: string; try { text = await readFile(this.file, "utf8"); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return; throw error; }
    for (const line of text.split(/\r?\n/).filter(Boolean)) { const entry = CheckpointSchema.parse(JSON.parse(line) as unknown); this.accept(entry); }
  }
  get(attemptId: string): CheckpointEntry | undefined { return this.entries.get(attemptId); }
  private accept(entry: CheckpointEntry): void {
    const previous = this.entries.get(entry.attemptId);
    if (previous !== undefined && previous.requestSha256 !== entry.requestSha256) throw new Error("attempt_conflict");
    this.entries.set(entry.attemptId, entry);
  }
  async write(value: CheckpointEntry): Promise<void> {
    const entry = CheckpointSchema.parse(value); this.accept(entry); // Claim in memory synchronously before another caller may invoke.
    this.writes = this.writes.then(async () => { await mkdir(dirname(this.file), { recursive: true }); await appendFile(this.file, `${JSON.stringify(entry)}\n`, "utf8"); });
    await this.writes;
  }
}
export interface AttemptIdentity {
  readonly uid: string; readonly runKey: string; readonly sourceSha256: string; readonly engineProfile: string;
  readonly fingerprint: string; readonly proposer: string; readonly model: string; readonly attempt: number;
}
/** Deterministic custom name UUID (version8), including uid and every pinned execution identity. */
export async function deterministicAttemptId(identity: AttemptIdentity): Promise<string> {
  const digest = await sha256Text(canonicalJson({ ...identity, schemaVersion: SCHEMA_VERSION, promptVersion: PROMPT_VERSION }));
  const variant = ((Number.parseInt(digest.charAt(16), 16) & 3) | 8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
export function createCheckpointTransport(options: { session: OperatorSession; checkpoint: Pick<EvalCheckpoint, "get" | "write">; ledger: Pick<FsLedger, "record">;
  wait?: (ms: number) => Promise<void> }) {
  let active = 0; let stopped = false;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const read = async (request: ProposeRequest, binding: string): Promise<LlmCall | null> => {
    const raw = await options.session.readOwnCall(request.attemptId); if (raw === null) return null;
    const call = LlmCallSchema.parse(raw);
    if (call.user_id !== options.session.userId || call.attempt_id !== request.attemptId || call.request_sha256 !== binding) throw new Error("attempt_conflict");
    await options.ledger.record(call); return call;
  };
  const recover = async (request: ProposeRequest, binding: string): Promise<ProposeResponse> => {
    let call: LlmCall | null = null;
    try { call = await read(request, binding); if (call?.status === "reserved") { await wait(500); call = await read(request, binding); } }
    catch (error) { return { kind: "error", code: error instanceof Error && error.message === "attempt_conflict" ? "attempt_conflict" : "provider_error" }; }
    return { kind: "error", code: call === null ? "provider_error" : call.status === "reserved" ? "attempt_in_progress" : "attempt_already_settled",
      ...(call === null ? {} : { usage: usageFromCall(call) }) };
  };
  return { isStopped: () => stopped,
    async invoke(request: ProposeRequest): Promise<{ httpStatus: number; body: unknown }> {
      const binding = (await requestHashes(options.session.userId, request)).requestSha256;
      const prior = options.checkpoint.get(request.attemptId);
      if (prior !== undefined && prior.requestSha256 !== binding) return { httpStatus: 200, body: { kind: "error", code: "attempt_conflict" } };
      if (prior !== undefined) {
        const body = prior.phase === "completed" && prior.response !== null && !(prior.response.kind === "error" && prior.response.code === "attempt_in_progress") ? prior.response : await recover(request, binding);
        if (body.kind === "error" && body.code === "budget_exceeded") stopped = true;
        // Successful checkpoint replay still refreshes the exact ledger snapshot, without invoking the provider.
        try { await read(request, binding); } catch (error) {
          if (error instanceof Error && error.message === "attempt_conflict") return { httpStatus: 200, body: { kind: "error", code: "attempt_conflict" } };
          // Missing ledger cost remains null, never reconstructed from timestamps.
        }
        return { httpStatus: 200, body };
      }
      if (stopped) return { httpStatus: 200, body: { kind: "error", code: "budget_exceeded" } };
      if (active >= 2) return { httpStatus: 200, body: { kind: "error", code: "rate_limited" } };
      active++;
      try {
        await options.checkpoint.write({ attemptId: request.attemptId, requestSha256: binding, phase: "started", response: null });
        let response: { httpStatus: number; body: unknown };
        try { response = await options.session.invoke(request); }
        catch {
          await options.checkpoint.write({ attemptId: request.attemptId, requestSha256: binding, phase: "lost", response: null });
          return { httpStatus: 200, body: await recover(request, binding) }; // A settled lost response is inconclusive, never re-called.
        }
        const parsed = ProposeResponseSchema.safeParse(response.httpStatus === 401 ? { kind: "error", code: "unauthorized" } : response.body);
        if (!parsed.success) {
          await options.checkpoint.write({ attemptId: request.attemptId, requestSha256: binding, phase: "lost", response: null });
          try { await read(request, binding); } catch { /* Remote reports bad_response; usage is unknown unless actual read-back succeeds. */ }
          return response;
        }
        await options.checkpoint.write({ attemptId: request.attemptId, requestSha256: binding, phase: "completed", response: parsed.data });
        try { await read(request, binding); } catch (error) {
          if (error instanceof Error && error.message === "attempt_conflict") {
            const conflict = { kind: "error" as const, code: "attempt_conflict" as const };
            await options.checkpoint.write({ attemptId: request.attemptId, requestSha256: binding, phase: "completed", response: conflict });
            return { httpStatus: 200, body: conflict };
          }
          // A validated outcome is retained; unavailable cost stays null.
        }
        if (parsed.data.kind === "error" && parsed.data.code === "budget_exceeded") stopped = true;
        return { httpStatus: response.httpStatus, body: parsed.data };
      } finally { active--; }
    },
  };
}
