import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Keep the .js extension the packages publish today; tsdown defaults to .mjs on Node.
  fixedExtension: false,
  deps: {
    neverBundle: [
      "@tenora/core",
      "commander",
    ],
  },
});
