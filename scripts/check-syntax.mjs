// Dirty Mode static syntax check (PLAN.md section 1). This is a PARSE, not a type check.
//
// .ts / .mts : module.stripTypeScriptTypes(src, { mode: "strip" }) (rejects non-erasable syntax such as
//              `enum`, `namespace`, parameter properties), then new vm.SourceTextModule(js) - compiled only,
//              never linked or evaluated.
// .js / .mjs : parsed as ES modules directly (package.json sets "type": "module").
// .tsx / other: not parsed (source review only); reported as SKIP when named or found.
//
// Usage: node --experimental-vm-modules --no-warnings scripts/check-syntax.mjs <file-or-dir> [...]
// Directories are walked recursively; node_modules, .git, dist, coverage and .act-cache are skipped.
import { stripTypeScriptTypes } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const TS_EXTENSIONS = new Set([".ts", ".mts"]);
const JS_EXTENSIONS = new Set([".js", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".act-cache"]);

if (typeof vm.SourceTextModule !== "function") {
  console.error("vm.SourceTextModule is unavailable: run with node --experimental-vm-modules");
  process.exit(2);
}
if (typeof stripTypeScriptTypes !== "function") {
  console.error("module.stripTypeScriptTypes is unavailable in this Node version (verified on v24.18.0)");
  process.exit(2);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: node --experimental-vm-modules --no-warnings scripts/check-syntax.mjs <file-or-dir> [...]");
  process.exit(2);
}

/** @type {{ file: string, kind: "ts" | "js" | "skip" }[]} */
const files = [];
let bad = 0;

function classify(file) {
  const ext = path.extname(file).toLowerCase();
  if (file.toLowerCase().endsWith(".d.ts")) return "ts";
  if (TS_EXTENSIONS.has(ext)) return "ts";
  if (JS_EXTENSIONS.has(ext)) return "js";
  return "skip";
}

function collect(target, named) {
  let st;
  try {
    st = statSync(target);
  } catch (e) {
    bad++;
    console.log("FAIL", target, e.code ?? e.name, "path not found");
    return;
  }
  if (st.isDirectory()) {
    const entries = readdirSync(target, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      collect(path.join(target, entry.name), false);
    }
    return;
  }
  if (!st.isFile()) return;
  const kind = classify(target);
  if (kind === "skip") {
    // Only report skipped source files that a reviewer would expect to be checked.
    if (named || /\.(tsx|jsx|cts|cjs)$/i.test(target)) files.push({ file: target, kind });
    return;
  }
  files.push({ file: target, kind });
}

for (const t of targets) collect(t, true);

let ok = 0;
let skipped = 0;
for (const { file, kind } of files) {
  if (kind === "skip") {
    skipped++;
    console.log("SKIP", file, "(source review only)");
    continue;
  }
  try {
    const src = readFileSync(file, "utf8");
    const js = kind === "ts" ? stripTypeScriptTypes(src, { mode: "strip" }) : src;
    new vm.SourceTextModule(js, { identifier: file }); // parse/compile only, no link/evaluate
    ok++;
    console.log("OK  ", file);
  } catch (e) {
    bad++;
    console.log("FAIL", file, e.code ?? e.name, String(e.message).split("\n")[0]);
  }
}

console.log(`\nsummary: ${ok} ok, ${bad} failed, ${skipped} skipped (source review only)`);
process.exitCode = bad ? 1 : 0;
