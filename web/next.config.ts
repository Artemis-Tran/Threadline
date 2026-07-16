import type { NextConfig } from "next";
import path from "node:path";

const repoRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  outputFileTracingRoot: repoRoot,
  turbopack: {
    root: repoRoot,
  },
};

export default nextConfig;
