// Explicit activation command. Source only in Dirty Mode: never invoked during construction.
import { createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GoldPageSchema } from "../gold/oracle/schema.ts";
import { ManifestSchema } from "../fixtures/manifestSchema.ts";
import { GENERATED_RULES, generateCorpus, plantedRuleCounts } from "../src/node/fixtures/generate.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let seed = 20261024;
  let freezeDate = new Date().toISOString().slice(0, 10);
  let outputRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (value === undefined) throw new Error("Usage: gen-fixtures [--seed <uint32>] [--freeze-date YYYY-MM-DD] [--out <empty product-like directory>]");
    if (flag === "--seed") seed = Number(value);
    else if (flag === "--freeze-date") freezeDate = value;
    else if (flag === "--out") outputRoot = resolve(value);
    else throw new Error("unknown_generator_argument");
  }
  const pages = generateCorpus(seed);
  const entries = pages.map((page) => ({ id: page.id, file: `fixtures/pages/${page.id}.html`, oracleFile: `gold/oracle/${page.id}.json`,
    family: page.family, split: page.split, sha256: createHash("sha256").update(page.source, "utf8").digest("hex"), defectCount: page.defects.length }));
  const counts = { dev: plantedRuleCounts(pages, "dev"), heldout: plantedRuleCounts(pages, "heldout") };
  const shortfalls = GENERATED_RULES.filter((rule) => (counts.heldout[rule] ?? 0) < 10)
    .map((rule) => ({ rule, required: 10, planted: counts.heldout[rule] ?? 0 }));
  const manifest = ManifestSchema.parse({ schemaVersion: 1, seed, freezeDate, pages: entries, plantedCountsByRule: counts, shortfalls });
  const writes: { file: string; text: string }[] = [];
  pages.forEach((page, index) => {
    const entry = entries[index]; if (entry === undefined) throw new Error("manifest_entry_missing");
    const oracle = GoldPageSchema.parse({ schemaVersion: 1, pageId: page.id, file: entry.file, family: page.family, split: page.split,
      sourceSha256: entry.sha256, defects: page.defects });
    writes.push({ file: entry.file, text: page.source }, { file: entry.oracleFile, text: JSON.stringify(oracle, null, 2) + "\n" });
  });
  writes.push({ file: "fixtures/MANIFEST.json", text: JSON.stringify(manifest, null, 2) + "\n" });
  // Refuse existing outputs rather than erasing a frozen corpus. Use --out for another reproducibility copy.
  for (const item of writes) {
    try { await access(resolve(outputRoot, item.file)); } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`refusing_to_overwrite:${item.file}`);
  }
  for (const item of writes) {
    const path = resolve(outputRoot, item.file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, item.text, { encoding: "utf8", flag: "wx" });
  }
  console.log(JSON.stringify({ pages: pages.length, plantedCountsByRule: counts, shortfalls,
    note: "Planted counts only. Run evaluation to report actual baseline detections and measured-rule shortfalls." }, null, 2));
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "fixture_generation_failed"); process.exitCode = 1; });
