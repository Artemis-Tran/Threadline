import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// base is the GitHub Pages project subpath. Overridable via THREADLINE_BASE so
// a different repo name / a user site (base "/") doesn't require editing this
// file. HashRouter means routing itself doesn't depend on base — only asset
// URLs do.
const base = process.env.THREADLINE_BASE ?? "/Threadline/";

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  // jsdom so components can be rendered and interacted with; the lib-level
  // tests that predate it don't care either way. Assertions stay on
  // node:assert/strict, so vitest's globals are left off and `test` is
  // imported explicitly.
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
  },
});
