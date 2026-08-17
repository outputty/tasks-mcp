import { defineConfig } from "tsdown";

// Bundle the TS sources to ESM in dist/ via tsdown (Rolldown + oxc — the oxc-transform pipeline with
// a bundler CLI around it). The bin keeps its shebang; deps stay external (they are in package.json
// dependencies and resolved at runtime).
export default defineConfig({
  entry: {
    cli: "bin/cli.ts",
    index: "src/core/index.ts",
    mcp: "src/mcp/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node18",
  clean: true,
  dts: false,
  // The package is type:module and its exports point at .js — never .mjs.
  outExtensions: () => ({ js: ".js" }),
});
