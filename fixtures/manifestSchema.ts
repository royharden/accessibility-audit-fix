// Schema only in Dirty Mode: MANIFEST.json is produced by explicit generation at activation.
import { z } from "../src/shared/deps.ts";

const RuleCountsSchema = z.record(z.string(), z.number().int().nonnegative());
export const ManifestPageSchema = z.object({
  id: z.string().min(1).max(100), file: z.string().min(1).max(300), oracleFile: z.string().min(1).max(300),
  split: z.enum(["dev", "heldout"]), family: z.string().min(1).max(100),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), defectCount: z.number().int().min(1).max(50),
}).strict();
export const ManifestSchema = z.object({
  schemaVersion: z.literal(1), seed: z.number().int().nonnegative(), freezeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pages: z.array(ManifestPageSchema).length(40),
  plantedCountsByRule: z.object({ dev: RuleCountsSchema, heldout: RuleCountsSchema }).strict(),
  shortfalls: z.array(z.object({ rule: z.string(), required: z.number().int().nonnegative(), planted: z.number().int().nonnegative() }).strict()),
}).strict();
export type FixtureManifest = z.infer<typeof ManifestSchema>;
