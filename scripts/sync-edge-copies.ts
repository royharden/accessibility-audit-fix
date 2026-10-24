// Explicit activation maintenance command. Never run during Dirty Mode or implicitly by test/build/install.
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("../src/shared/", import.meta.url));
const target = fileURLToPath(new URL("../supabase/functions/propose-fix/shared/", import.meta.url));
async function walk(directory: string): Promise<string[]> {
  const files: string[] = []; for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name); if (item.isDirectory()) files.push(...await walk(path)); else if (item.name.endsWith(".ts")) files.push(path);
  } return files.sort();
}
for (const file of await walk(source)) {
  const name = relative(source, file); const output = join(target, name);
  if (name === "deps.ts") { await readFile(output, "utf8"); continue; } // Preserve the reviewed, separately pinned Deno import.
  await mkdir(dirname(output), { recursive: true }); await copyFile(file, output);
}
console.log("Shared edge copies synchronized; deps.ts preserved. Run byte-parity contract tests before deployment.");
