// Explicit activation command only. This file is never imported by tests, eval, builds or fixture generation.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ActFetchManifestSchema, fetchPinnedActCase } from "../src/node/act.ts";

async function main(): Promise<void> {
  const index = process.argv.indexOf("--manifest"); const manifestFile = index < 0 ? undefined : process.argv[index + 1];
  if (manifestFile === undefined || manifestFile.startsWith("--")) throw new Error("Use --manifest <reviewed-local-pin-manifest.json>; terms, URLs, rule map and SHA256 pins must be reviewed first.");
  const manifest = ActFetchManifestSchema.parse(JSON.parse(await readFile(manifestFile, "utf8")) as unknown);
  if (new Set(manifest.cases.map((item) => item.id)).size !== manifest.cases.length) throw new Error("duplicate_act_case_id");
  const output = fileURLToPath(new URL("../.act-cache/", import.meta.url)); await mkdir(output, { recursive: true });
  const saved: { id: string; file: string; finalUrl: string; sha256: string; actRuleId: string; axeRule: string; expectation: string }[] = [];
  for (const entry of manifest.cases) {
    const fetched = await fetchPinnedActCase(entry); const file = `${entry.id}.html`;
    await writeFile(resolve(output, file), fetched.source, { encoding: "utf8", flag: "wx" });
    saved.push({ id: entry.id, file, finalUrl: fetched.finalUrl, sha256: fetched.sha256, actRuleId: entry.actRuleId, axeRule: entry.axeRule, expectation: entry.expectation });
  }
  await writeFile(resolve(output, "MANIFEST.json"), `${JSON.stringify({ schemaVersion: 1, cases: saved }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(`Saved ${saved.length} explicitly pinned ACT cases; eval never fetches them automatically.`);
}
void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "act_fetch_failed"); process.exitCode = 1; });
