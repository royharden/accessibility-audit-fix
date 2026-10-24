import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The bundle input is index.html only, so nothing under src/node, scripts/ or gold/ can enter the browser
// bundle unless src/app or src/core imports it (forbidden by eslint.config.js). The dev-server host port is
// claimed from the agent-ports ledger at activation, not hard-coded here.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: "index.html",
    },
  },
});
