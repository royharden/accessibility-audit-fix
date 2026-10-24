// The ONLY third-party import point for src/shared (closure rule, PLAN.md section 1).
// The edge copy (supabase/functions/propose-fix/) differs in exactly this file: it re-exports zod from
// "npm:zod@<pin>" instead. Every other src/shared file is copied byte-identically.
// The code in src/shared uses only the zod API surface common to zod 3.23+ and zod 4 (z.object().strict(),
// z.discriminatedUnion, z.literal, z.enum, z.string/number/array, superRefine, safeParse); the major version is
// pinned at activation.
export { z } from "zod";
