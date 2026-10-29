// Activation-only local probe. Never imported by tests or automatically invoked by install/build.
// This measures the nine declared jsdom MVP rules on paired positive/negative fixtures. It cannot measure iframe.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import axe from "axe-core";
import { parsePage } from "../src/core/html/parse.ts";
import { buildRenderCopy } from "../src/core/html/renderCopy.ts";
import { createJsdomEngine } from "../src/node/jsdomEngine.ts";

const cases = [
  { rule: "html-has-lang", bad: "", good: ' lang="en"', html: true },
  { rule: "document-title", bad: "", good: "<title>Store</title>", head: true },
  { rule: "image-alt", bad: "<img>", good: '<img alt="Mountain landscape">' },
  { rule: "button-name", bad: "<button></button>", good: "<button>Search</button>" },
  { rule: "link-name", bad: '<a href="#"></a>', good: '<a href="#">Details</a>' },
  { rule: "label", bad: "<input>", good: '<input aria-label="Search">' },
  { rule: "frame-title", bad: "<iframe></iframe>", good: '<iframe title="Map"></iframe>' },
  { rule: "heading-order", bad: "<h1>Main</h1><h3>Section</h3>", good: "<h1>Main</h1><h2>Section</h2>" },
  { rule: "tabindex", bad: '<button tabindex="3">Search</button>', good: '<button>Search</button>' },
];
const path = new URL("../engine-profile.json", import.meta.url);
const declared = JSON.parse(await readFile(path, "utf8")) as {
  status: string; axeVersion: string; engines: { jsdom: import("../src/node/jsdomEngine.ts").JsdomProfile & { measuredEligibleRules: string[]; [key: string]: unknown }; [key: string]: unknown };
};
const executionFailures = new Set<string>();
async function probe(profile: import("../src/node/jsdomEngine.ts").JsdomProfile) {
 const evidence: { rule: string; measured: boolean; baselineStatus: string; fixedStatus: string }[] = [];
 for (const item of cases) {
  const page = (part: string): string => `<!doctype html><html${"html" in item ? part : ' lang="en"'}><head>${"head" in item ? part : "<title>Probe</title>"}</head><body>${"html" in item || "head" in item ? "<main>Probe</main>" : `<main>${part}</main>`}</body></html>`;
  const bad = page(item.bad); const good = page(item.good);
  const baseline = await createJsdomEngine({ source: parsePage(bad), profile }).audit(buildRenderCopy(bad).html);
  const fixed = await createJsdomEngine({ source: parsePage(good), profile }).audit(buildRenderCopy(good).html);
  for (const error of [...baseline.errors, ...fixed.errors]) if (error.code.startsWith("axe_check_error:")) executionFailures.add(error.code.slice("axe_check_error:".length));
  const measured = baseline.status === "complete" && fixed.status === "complete" &&
    baseline.findings.some((f) => f.rule === item.rule) && ![...fixed.findings, ...fixed.incomplete].some((f) => f.rule === item.rule);
  evidence.push({ rule: item.rule, measured, baselineStatus: baseline.status, fixedStatus: fixed.status });
 }
 return evidence;
}
// Discover failing checks across the full default rule set, then measure the targets with those excluded.
await probe(declared.engines.jsdom);
const candidate = { ...declared.engines.jsdom,
  excludedRules: [...new Set([...declared.engines.jsdom.excludedRules, ...executionFailures])],
  notMeasuredRules: [...new Set([...declared.engines.jsdom.notMeasuredRules, ...executionFailures])] };
const evidence = await probe(candidate);
const failed = evidence.filter((e) => !e.measured).map((e) => e.rule);
declared.axeVersion = axe.version;
declared.status = "jsdom_probed_iframe_declared";
declared.engines.jsdom = { ...candidate,
  excludedRules: [...new Set([...candidate.excludedRules, ...executionFailures, ...failed])],
  notMeasuredRules: [...new Set([...candidate.notMeasuredRules, ...executionFailures, ...failed])],
  measuredEligibleRules: evidence.filter((e) => e.measured).map((e) => e.rule), status: "paired_fixture_probe", probeEvidence: evidence };
const configHash = createHash("sha256").update(JSON.stringify({ axeVersion: axe.version, ...declared.engines.jsdom, profileId: undefined })).digest("hex").slice(0, 12);
declared.engines.jsdom = { ...declared.engines.jsdom, profileId: `jsdom-probed-${axe.version}-${configHash}` };
if (process.argv.includes("--write")) await writeFile(path, `${JSON.stringify(declared, null, 2)}\n`, "utf8");
else console.log("Preview only. Use --write at activation to freeze the measured jsdom profile; iframe remains declared.");
console.log(JSON.stringify(declared, null, 2));
