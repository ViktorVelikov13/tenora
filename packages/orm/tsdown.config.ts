import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Keep the .js extension the other packages publish; tsdown defaults to .mjs on Node.
  fixedExtension: false,
  deps: {
    // Drivers are the project's own and are resolved at runtime; Kysely is pinned, not bundled.
    neverBundle: [
      "kysely",
      "pg",
      "mysql2",
      "mariadb",
      "better-sqlite3",
      "tedious",
    ],
  },
});
