# @tenora/core

## 0.5.0

### Minor Changes

- b142d19: Show progress in the terminal, and add `--step` to run migrations one at a time.
  
  - In a terminal, `migrate`, `rollback`, `seed:run` and their tenant versions now show a live task tree: which migration is running, what finished and how long it took, what failed and why, what was rolled back with it and what never ran. Tenant commands also show a progress bar. The other commands get a one-line result.
  - Output that is piped or redirected, or that runs in CI (`CI` is set) or with `TERM=dumb`, stays exactly as it was, so scripts keep working. `NO_COLOR` turns the colours off.
  - No new dependencies.
  - `tenora migrate --step`, also on `migrate:base` and `migrate:tenants`, gives every migration its own batch, so `tenora rollback` undoes them one at a time. If one fails, the ones before it stay applied.

## 0.4.0

### Minor Changes

- b1ea2c2: Replace the unmaintained `crypto-js` with Node's built-in `crypto`.
  
  - `encryptPassword` now uses AES-256-GCM and writes values starting with `tenora:v1:`. `decryptPassword` still reads passwords stored by earlier versions, so existing tenants keep working with no migration.
  - `decryptPassword` with the wrong key, or on a damaged value, now throws a clear "could not decrypt the tenant password" error. Before, it could return an empty or garbled string.
  - `generateTenantPassword` now uses a cryptographically secure random source instead of `Math.random()`. Length and characters are unchanged.
  - `crypto-js` is no longer installed with Tenora. If your own code imports it, add it to your own dependencies. If your code decrypts registry values with crypto-js directly, switch to `decryptPassword`, which reads both formats.
  
  The packages are now built with tsdown and TypeScript 7. They publish the same files with the same exports.
- fe6d262: Add tenant schema dumps, so creating a tenant no longer runs every migration one by one.
  
  - `tenora schema:dump:tenants` builds the tenant schema in a throwaway database and writes its structure, with no data, to `schema/tenant-<dialect>.sql` next to the tenant migrations. `createTenantDb` then loads that file into the new database and runs only the migrations newer than it.
  - `--check` fails when a migration file is missing from the dump, without needing a database, for use in CI.
  - `--prune` deletes the migration files the dump contains. Existing tenants keep migrating; rolling back into a pruned migration, or migrating a tenant that never ran one, fails with an explanation.
  - Supported on Postgres, MySQL, MariaDB and SQLite. Dumping needs `pg_dump`, `mysqldump` or `mariadb-dump` (override with `TENORA_PG_DUMP`, `TENORA_MYSQLDUMP`, `TENORA_MARIADB_DUMP`); loading needs no tools.
  - New: `TenantManager.dumpTenantSchema()`, `checkTenantSchemaDump()`, and the `tenant.schemaFile` option. Custom `TenantManager` implementations need the new method.
  
  Projects without a dump file behave exactly as before.

## 0.3.0

### Minor Changes

- 2b4055e: Add `dropTenantDb()` and `tenora drop:tenant <id> --force`, which permanently delete a tenant database, its user and its registry entry.
  
  Fixes:
  
  - Postgres 15+: tenants with a password can now create tables.
  - SQL Server: `createTenantDb` no longer fails at the registry step, `--create-base` works when the database exists, and the `sqlserver` client alias works.
  - `tenant.databaseName` is now used when creating server databases, not only when connecting.
  - The generated registry migration now works in `"type": "commonjs"` projects.
  - Migration templates keep multi-word table names, and `add_x_to_y_table` now alters the table instead of creating it.
  - The CLI now honours `TENORA_CONFIG`, as documented.
- 47866d4: Update dependencies to their latest versions, including commander 15, knex 3.3 and objection 4. Node.js 22.12 or newer is now required.

## 0.2.1

### Patch Changes

- Fix global CLI database driver resolution by loading `knex` from the current working directory first.

  - `@tenora/core` now resolves `knex` from the user project first, with fallback to package-local `knex`.
  - This allows globally installed `@tenora/cli` to use project-installed drivers like `pg` without requiring global driver installs.
  - No public API changes.

## 0.2.0

### Minor Changes

- Split CLI into a new standalone package (`@tenora/cli`), add shared core package (`@tenora/core`), and keep `@tenora/multi-tenant` CLI compatibility.

  - Add new `@tenora/cli` package so users can install `tenora` globally without manually installing the runtime package.
  - Add new `@tenora/core` package for shared config loading, registry helpers, password helpers, and shared types.
  - Move tenant manager factory into `@tenora/core` so `@tenora/cli` no longer depends on `@tenora/multi-tenant`.
  - Split CLI implementation into smaller modules under `@tenora/core/src/cli/*` and keep thin CLI entrypoints in `@tenora/cli` and `@tenora/multi-tenant`.
  - Keep `tenora` available from `@tenora/multi-tenant` for backwards-compatible upgrades.
  - Update workspace scripts and documentation for the three-package setup.
