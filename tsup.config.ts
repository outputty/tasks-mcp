import { defineConfig } from "tsup";

// Bundle the TS sources to ESM in dist/. The bin keeps its shebang; deps stay external (they are in
// package.json dependencies and resolved at runtime).
export default defineConfig({
  entry: {
    cli: "bin/cli.ts",
    index: "src/core/index.ts",
    mcp: "src/mcp/index.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  dts: false,
  splitting: false,
});
