import { defineConfig } from "vite";
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
});
