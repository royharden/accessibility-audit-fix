// ESLint flat config (ESLint >= 9, typescript-eslint). Written in Dirty Mode, never run.
//
// Bundle and closure boundaries (PLAN.md section 1):
//   - src/app and src/core never import src/node, jsdom or gold/ (the hidden oracle).
//   - src/core never imports node:* or Node builtins, browser-only code (src/app, src/engines) or react.
//   - src/shared uses only relative imports that resolve inside the src/shared subtree, always with an
//     explicit .ts extension; src/shared/deps.ts is the only file allowed to import "zod".
// Package-name bans use no-restricted-imports; path-based checks (which need the importing file's
// location) use the small local rule `local/import-boundaries` below, which resolves each specifier.
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function toRepoPath(absolute) {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

function isRelativeSpecifier(spec) {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

function under(repoPath, dir) {
  return repoPath === dir || repoPath.startsWith(`${dir}/`);
}

const importBoundaries = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      sharedBare: "src/shared may only import relative paths inside src/shared (only src/shared/deps.ts may import 'zod'): '{{spec}}'.",
      sharedEscape: "src/shared import '{{spec}}' resolves outside the src/shared subtree ({{target}}).",
      sharedExtension: "src/shared import '{{spec}}' must use an explicit .ts extension.",
      sharedDynamic: "src/shared may not use non-literal dynamic import().",
      nodeOnly: "'{{spec}}' resolves to {{target}}: src/app and src/core must never import src/node or gold/.",
      coreBrowser: "'{{spec}}' resolves to {{target}}: src/core is isomorphic and must not import src/app or src/engines.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const fileRepo = toRepoPath(filename);
    const inShared = under(fileRepo, "src/shared");
    const inCore = under(fileRepo, "src/core");
    const inApp = under(fileRepo, "src/app");
    const isDeps = fileRepo === "src/shared/deps.ts";
    if (!inShared && !inCore && !inApp) return {};

    function check(node, sourceNode) {
      if (!sourceNode) return;
      if (sourceNode.type !== "Literal" || typeof sourceNode.value !== "string") {
        if (inShared) context.report({ node, messageId: "sharedDynamic" });
        return;
      }
      const spec = sourceNode.value;
      const relative = isRelativeSpecifier(spec);
      const target = relative ? toRepoPath(path.resolve(path.dirname(filename), spec)) : null;

      if (inShared) {
        if (!relative) {
          if (!(isDeps && spec === "zod")) context.report({ node, messageId: "sharedBare", data: { spec } });
          return;
        }
        if (target === null || !under(target, "src/shared")) {
          context.report({ node, messageId: "sharedEscape", data: { spec, target: target ?? "?" } });
        }
        if (!spec.endsWith(".ts")) context.report({ node, messageId: "sharedExtension", data: { spec } });
        return;
      }
      if (target === null) return;
      if (under(target, "src/node") || under(target, "gold")) {
        context.report({ node, messageId: "nodeOnly", data: { spec, target } });
      }
      if (inCore && (under(target, "src/app") || under(target, "src/engines"))) {
        context.report({ node, messageId: "coreBrowser", data: { spec, target } });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source);
      },
      ExportAllDeclaration(node) {
        check(node, node.source);
      },
      ImportExpression(node) {
        check(node, node.source);
      },
    };
  },
};

const NODE_BUILTINS = [
  "assert", "buffer", "child_process", "cluster", "crypto", "dgram", "dns", "events", "fs", "fs/promises", "http",
  "http2", "https", "module", "net", "os", "path", "perf_hooks", "process", "readline", "stream", "string_decoder",
  "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
];

const NODE_ONLY_PATHS = [
  { name: "jsdom", message: "jsdom is Node/dev only (src/node/jsdomEngine.ts)." },
];
const NODE_ONLY_PATTERNS = [
  { group: ["jsdom/*"], message: "jsdom is Node/dev only." },
  { group: ["**/src/node/**", "**/node/**"], message: "src/node is never imported by src/app or src/core." },
  { group: ["gold", "gold/*", "**/gold/**"], message: "The hidden oracle (gold/) is never importable by proposers, gates or the app." },
];
const NO_NODE_PATHS = NODE_BUILTINS.map((name) => ({ name, message: "No Node builtins here (isomorphic code)." }));
const NO_NODE_PATTERNS = [{ group: ["node:*"], message: "No node:* imports here (isomorphic code)." }];
const NO_UI_PATHS = [
  { name: "react", message: "src/core is UI-free." },
  { name: "react-dom", message: "src/core is UI-free." },
];

const NO_RUNTIME_GLOBALS = [
  "window", "document", "navigator", "location", "localStorage", "sessionStorage", "HTMLElement", "Element", "Node",
  "DOMParser", "process", "Buffer", "require", "__dirname", "__filename", "Deno",
].map((name) => ({ name, message: "src/core and src/shared are isomorphic: no DOM, Node or Deno globals." }));

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".act-cache/**", "coverage/**", "supabase/functions/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    plugins: { local: { rules: { "import-boundaries": importBoundaries } } },
    rules: {
      "local/import-boundaries": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "separate-type-imports" }],
    },
  },
  {
    files: ["scripts/**", "src/node/**", "tests/**", "*.config.{ts,js}", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["src/app/**", "src/engines/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ["src/app/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: NODE_ONLY_PATHS, patterns: NODE_ONLY_PATTERNS }],
    },
  },
  {
    files: ["src/core/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...NODE_ONLY_PATHS, ...NO_NODE_PATHS, ...NO_UI_PATHS],
          patterns: [...NODE_ONLY_PATTERNS, ...NO_NODE_PATTERNS],
        },
      ],
      "no-restricted-globals": ["error", ...NO_RUNTIME_GLOBALS],
    },
  },
  {
    files: ["src/shared/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [...NODE_ONLY_PATHS, ...NO_NODE_PATHS, ...NO_UI_PATHS],
          patterns: [...NODE_ONLY_PATTERNS, ...NO_NODE_PATTERNS],
        },
      ],
      "no-restricted-globals": ["error", ...NO_RUNTIME_GLOBALS],
    },
  },
);
