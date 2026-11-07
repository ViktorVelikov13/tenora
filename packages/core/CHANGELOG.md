# @tenora/core

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
