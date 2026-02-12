import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "@tenora/core",
    "knex",
    "commander",
    "pg",
    "mysql2",
    "mariadb",
    "sqlite3",
    "better-sqlite3",
    "mssql",
  ],
});
