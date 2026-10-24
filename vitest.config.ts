import { defineConfig } from "vitest/config";

// Tests never touch the network: fetch-act is never invoked by tests, providers are reached only through
// mocks. Written in Dirty Mode, not run.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
