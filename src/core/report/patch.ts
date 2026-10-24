import { createTwoFilesPatch } from "diff";
import type { CombineResult } from "../gate/combine.ts";
import type { Artifact } from "../loop/runPage.ts";

/** Export source only after exact approvals and the combined recheck. Blocked output has no patch. */
export function combinedPatch(artifact: Artifact, combined: CombineResult): string | null {
  if (combined.state !== "ready") return null;
  // The file label is code-owned metadata, never interpreted as a filesystem path by the core.
  const file = artifact.file.replace(/[\r\n\t]/g, "_");
  return createTwoFilesPatch(`a/${file}`, `b/${file}`, artifact.source, combined.text, "", "", { context: 3 });
}
