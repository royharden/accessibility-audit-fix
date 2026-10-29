// Exact llm_calls snapshots from authenticated read-back only. No made-up timestamps, prices or token counts.
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { LlmCallSchema } from "../shared/proposeResponse.ts";
import type { LlmCall } from "../shared/proposeResponse.ts";
export class FsLedger {
  private readonly calls = new Map<string, LlmCall>();
  private writes: Promise<void> = Promise.resolve();
  readonly file: string;
  constructor(file: string) { this.file = file; }
  async load(): Promise<void> {
    let text: string; try { text = await readFile(this.file, "utf8"); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return; throw error; }
    for (const line of text.split(/\r?\n/).filter(Boolean)) { const call = LlmCallSchema.parse(JSON.parse(line) as unknown); this.calls.set(call.id, call); }
  }
  async record(value: unknown): Promise<LlmCall> {
    const call = LlmCallSchema.parse(value);
    if (JSON.stringify(this.calls.get(call.id)) === JSON.stringify(call)) return call;
    const write = this.writes.then(async () => { await mkdir(dirname(this.file), { recursive: true }); await appendFile(this.file, `${JSON.stringify(call)}\n`, "utf8"); this.calls.set(call.id, call); });
    this.writes = write; await write; return call;
  }
  /** Latest snapshot per call id; repeats/resume never double-charge the report. Missing/unknown cost stays null. */
  costFor(attemptIds: readonly string[]): number | null {
    if (attemptIds.length === 0) return null;
    let total = 0;
    for (const id of new Set(attemptIds)) {
      const matches = [...this.calls.values()].filter((call) => call.attempt_id === id);
      if (matches.length !== 1 || matches[0]?.cost_usd_micros === null || matches[0]?.cost_usd_micros === undefined) return null;
      total += matches[0].cost_usd_micros;
    }
    return total;
  }
}
