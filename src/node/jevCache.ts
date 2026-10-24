import { readFile, appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "../shared/deps.ts";
import { JevCacheEntrySchema } from "../core/proposers/jev.ts";
import type { JevCache, JevCacheEntry } from "../core/proposers/jev.ts";
const RecordSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), decision: JevCacheEntrySchema }).strict();
/** Typed decisions + actual original call identity only; never a cached usage/current-attempt envelope. */
export class JsonlJevCache implements JevCache {
  readonly file: string; private values = new Map<string, JevCacheEntry>(); private writes: Promise<void> = Promise.resolve();
  constructor(file: string) { this.file = file; }
  async load(): Promise<void> { let text: string;
    try { text = await readFile(this.file, "utf8"); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return; throw error; }
    for (const line of text.split(/\r?\n/).filter(Boolean)) { const record = RecordSchema.parse(JSON.parse(line) as unknown); this.values.set(record.key, record.decision); }
  }
  async get(key: string): Promise<JevCacheEntry | null> { const value = this.values.get(key); return value === undefined ? null : JevCacheEntrySchema.parse(value); }
  async put(key: string, decision: JevCacheEntry): Promise<void> {
    const record = RecordSchema.parse({ key, decision }); this.writes = this.writes.then(async () => { await mkdir(dirname(this.file), { recursive: true }); await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8"); this.values.set(key, record.decision); }); await this.writes;
  }
}
