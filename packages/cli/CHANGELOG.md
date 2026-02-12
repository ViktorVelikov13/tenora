# @tenora/cli

## 0.2.1

### Patch Changes

- Fix global CLI database driver resolution by loading `knex` from the current working directory first.

  - `@tenora/core` now resolves `knex` from the user project first, with fallback to package-local `knex`.
  - This allows globally installed `@tenora/cli` to use project-installed drivers like `pg` without requiring global driver installs.
  - No public API changes.

- Updated dependencies
  - @tenora/core@0.2.1

## 0.2.0

### Minor Changes

- Split CLI into a new standalone package (`@tenora/cli`), add shared core package (`@tenora/core`), and keep `@tenora/multi-tenant` CLI compatibility.

  - Add new `@tenora/cli` package so users can install `tenora` globally without manually installing the runtime package.
  - Add new `@tenora/core` package for shared config loading, registry helpers, password helpers, and shared types.
  - Move tenant manager factory into `@tenora/core` so `@tenora/cli` no longer depends on `@tenora/multi-tenant`.
  - Split CLI implementation into smaller modules under `@tenora/core/src/cli/*` and keep thin CLI entrypoints in `@tenora/cli` and `@tenora/multi-tenant`.
  - Keep `tenora` available from `@tenora/multi-tenant` for backwards-compatible upgrades.
  - Update workspace scripts and documentation for the three-package setup.

### Patch Changes

- Updated dependencies
  - @tenora/core@0.2.0
