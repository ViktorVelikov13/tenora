# @tenora/cli

Standalone Tenora CLI package.

`@tenora/cli` provides the `tenora` command so users can run migrations/seeds and tenant-wide DB operations without relying on a specific runtime package install layout.

## Why `@tenora/cli`?
- Install globally and run `tenora` anywhere.
- Install project-local and run via `npx tenora`.
- Keep CLI concerns separate from application runtime code.

## Installation
Global install:

```bash
npm install -g @tenora/cli
```

Project-local install:

```bash
npm install -D @tenora/cli
npx tenora list
```

## Commands
- `tenora migrate` (alias `migrate:base`)
- `tenora rollback` (alias `rollback:base`)
- `tenora migrate:tenants`
- `tenora rollback:tenants`
- `tenora drop:tenant <id> --force`
- `tenora make:migration <name>` (alias `make:migration:base`)
- `tenora make:migration:tenants <name>`
- `tenora make:seed <name>` (alias `make:seed:base`)
- `tenora make:seed:tenants <name>`
- `tenora seed:run` (alias `seed:run:base`)
- `tenora seed:run:tenants`
- `tenora list`

## Common options
- `-c, --config <path>`: explicit config file path.
- `--create-base`: create the base DB if it does not exist.
- `--esm` / `--cjs`: template module format override for `make:migration*` and `make:seed*`.
- `--force`: required by `drop:tenant`, which permanently deletes the tenant database, its user and its registry entry.
- `--allow-unregistered`: let `drop:tenant` remove a tenant that is missing from the registry, such as one left behind by a failed create.

## Config lookup
If `--config` is not set, CLI checks this order from current working directory:
- `tenora.config.js`
- `tenora.config.mjs`
- `tenora.config.ts`

You can also set `TENORA_CONFIG`.

## Example workflow
```bash
# Create base DB if needed and run base migrations
tenora migrate --create-base

# Run tenant migrations for all tenants in registry
tenora migrate:tenants

# Generate a tenant migration template
tenora make:migration:tenants add_status_to_invoices

# Run tenant seeds
tenora seed:run:tenants

# Permanently delete a tenant
tenora drop:tenant acme --force
```

## Notes
- Registry migration is auto-generated if missing when running base migrate.
- `make:migration:*` requires configured migrations directories.
- `make:seed:*` and `seed:run*` require configured seed directories.
- Template output defaults to nearest `package.json` module type unless overridden.
- `drop:tenant` refuses tenants missing from the registry unless `--allow-unregistered` is set, and always refuses the base database and system databases.
- For global CLI installs, keep your DB driver in the target project (for example `pg`, `mysql2`, `mariadb`, `sqlite3`, or `tedious` for SQL Server).

## Relationship to other packages
- Depends on `@tenora/core` for shared CLI + factory internals.
- Can be installed and used independently by end users.
