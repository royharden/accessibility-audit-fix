// Activation-only offline demo source. Never executed during Dirty Mode.
// Uses real local jsdom audits plus explicitly scripted proposals; no provider or backend calls.
import { readFile, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { MAX_INPUT_BYTES, utf8ByteLength } from "../src/core/limits.ts";
import { runPage } from "../src/core/loop/runPage.ts";
import { createMockProposer, parseReplayScript } from "../src/core/proposers/mock.ts";
import { rulesProposer } from "../src/core/proposers/rules.ts";
import { createJsdomEngine } from "../src/node/jsdomEngine.ts";

type DemoState = "verified" | "checked" | "rejected" | "needs_human" | "inconclusive";
interface DemoCase {
  readonly name: string;
  readonly expected: DemoState;
  readonly body: string;
  readonly replayFile: string;
}

const cases: readonly DemoCase[] = [
  {
    name: "Positive tabindex keeps keyboard access",
    expected: "verified",
    body: '<div tabindex="3">Book details</div>',
    replayFile: "demo-tabindex.json",
  },
  {
    name: "Meaningful alt still needs human review",
    expected: "checked",
    body: '<img src="mountain-lake.jpg">',
    replayFile: "demo-image-alt.json",
  },
  {
    name: "Deletion is not an allowed repair",
    expected: "rejected",
    body: '<img src="mountain-lake.jpg">',
    replayFile: "demo-delete-rejected.json",
  },
  {
    name: "A proposer can abstain",
    expected: "needs_human",
    body: '<img src="IMG_0042.jpg">',
    replayFile: "demo-abstain.json",
  },
  {
    name: "A scripted provider timeout is inconclusive",
    expected: "inconclusive",
    body: '<img src="mountain-lake.jpg">',
    replayFile: "demo-timeout.json",
  },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const file = args[1];
    if (args.length !== 2 || args[0] !== "--input" || file === undefined || file.length === 0) {
      throw new Error("Usage: npm run demo -- [--input <local UTF-8 HTML path>]");
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error("input_must_be_a_local_file");
    if (info.size > MAX_INPUT_BYTES) throw new Error("input_exceeds_200000_utf8_bytes");
    const bytes = await readFile(file);
    if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error("input_exceeds_200000_utf8_bytes");
    // Fatal decoding rejects invalid UTF-8; ignoreBOM=true retains U+FEFF in source/hash/export.
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (utf8ByteLength(source) > MAX_INPUT_BYTES) throw new Error("input_exceeds_200000_utf8_bytes");
    const result = await runPage({ source, file, proposer: rulesProposer,
      createEngine: (originalPage) => createJsdomEngine({ source: originalPage, file }) });
    if (result.status !== "audited") {
      console.log(JSON.stringify(result));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ mode: result.artifact.mode, engine: result.artifact.baseline.engine,
      profile: result.artifact.baseline.profile, axeVersion: result.artifact.baseline.axeVersion,
      queue: result.artifact.queue, items: result.artifact.items.map((entry) => ({
        fingerprint: entry.finding.fingerprint, rule: entry.finding.rule, state: entry.state, reasons: entry.reasons,
      })) }, null, 2));
    return;
  }
  console.log("S28 offline demo: real local jsdom audits; scripted mock proposals; no provider calls.");
  console.log("An expected state below is a contract, not a pre-recorded measurement. Actual outcomes follow.");
  const observed = new Set<DemoState>();
  for (const item of cases) {
    const source = `<!doctype html><html lang="en"><head><title>Book storefront</title></head><body>${item.body}</body></html>`;
    const replay = parseReplayScript(JSON.parse(await readFile(new URL(`../fixtures/proposals/${item.replayFile}`, import.meta.url), "utf8")) as unknown);
    const proposer = createMockProposer([replay]);
    const result = await runPage({ source, file: "demo.html", proposer,
      createEngine: (originalPage) => createJsdomEngine({ source: originalPage, file: "demo.html" }) });
    if (result.status !== "audited") {
      console.log(JSON.stringify({ case: item.name, expected: item.expected, actual: result.status, reasons: result.reasons }));
      continue;
    }
    const target = result.artifact.items.find((entry) => entry.finding.fingerprint === replay.fingerprint);
    console.log(JSON.stringify({ case: item.name, expected: item.expected, actual: target?.state ?? "target_not_detected",
      reasons: target?.reasons ?? ["baseline_did_not_detect_target"], mode: result.artifact.mode,
      engine: result.artifact.baseline.engine, profile: result.artifact.baseline.profile,
      axeVersion: result.artifact.baseline.axeVersion }));
    if (target?.state === item.expected) observed.add(item.expected);
  }
  if (observed.size !== cases.length) {
    throw new Error("Demo did not reproduce all five expected states. Inspect engine profile and actual outcomes; do not substitute scripted audit results.");
  }
  console.log("All five states observed in this execution. This is mock-proposal evidence, not held-out model evaluation.");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "demo_failed");
  process.exitCode = 1;
});
