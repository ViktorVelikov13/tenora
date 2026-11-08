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
- `tenora schema:dump:tenants`
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
- `--step`: make `migrate` and `migrate:tenants` give every migration its own batch, so `rollback` undoes them one at a time. If one fails, the ones before it stay applied.
- `--esm` / `--cjs`: template module format override for `make:migration*` and `make:seed*`.
- `--force`: required by `drop:tenant`, which permanently deletes the tenant database, its user and its registry entry.
- `--allow-unregistered`: let `drop:tenant` remove a tenant that is missing from the registry, such as one left behind by a failed create.
- `--prune`: let `schema:dump:tenants` delete the migration files the new dump contains.
- `--check`: make `schema:dump:tenants` only check that the dump contains every migration file, without a database.

## Output
In a terminal, migrations, rollbacks and seeds show a live task tree. Tenants that finished take one line, and the running one opens up to show each migration:

```text
tenora migrate:tenants

✔ acme  2 migrations · 1.4s
– globex  up to date
⠹ initech  1/3
  ✔ 20270101000000_create_orders.js  612ms
  ⠹ 20270101000001_add_invoices.js  1.2s
  ○ 20270101000002_add_audit_log.js

████████████░░░░░░░░░░░░  2/4 tenants  3.1s
```

A failure shows what happened to every migration in that run:

```text
✖ initech
  ↩ 20270101000000_create_orders.js  rolled back
  ✖ 20270101000001_add_invoices.js
    relation "customers" does not exist
  ○ 20270101000002_add_audit_log.js  not run

✖ Stopped on initech. 1 tenant migrated, 1 up to date, 1 not started.
```

The tree only appears when both stdout and stderr are a terminal. Piped or redirected output, CI (`CI` is set) and `TERM=dumb` get the plain lines, which are stable enough for scripts. `NO_COLOR` turns the colours off.

In the tree a failure shows its message only. To see the stack trace, pipe the output, for example `tenora migrate | cat`.

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

# Dump the tenant schema, so new tenants load it instead of running every migration
tenora schema:dump:tenants

# Permanently delete a tenant
tenora drop:tenant acme --force
```

## Notes
- Registry migration is auto-generated if missing when running base migrate.
- `make:migration:*` requires configured migrations directories.
- `make:seed:*` and `seed:run*` require configured seed directories.
- Template output defaults to nearest `package.json` module type unless overridden.
- `drop:tenant` refuses tenants missing from the registry unless `--allow-unregistered` is set, and always refuses the base database and system databases.
- `schema:dump:tenants` writes `schema/tenant-<dialect>.sql` next to the tenant migrations; `createTenantDb` then loads it and runs only newer migrations. It needs `pg_dump`, or `mysqldump`/`mariadb-dump`, at least as new as the server (override with `TENORA_PG_DUMP`, `TENORA_MYSQLDUMP`, `TENORA_MARIADB_DUMP`), and is not available for SQL Server. Run `migrate:tenants` everywhere before `--prune`. See the `@tenora/multi-tenant` README for details.
- For global CLI installs, keep your DB driver in the target project (for example `pg`, `mysql2`, `mariadb`, `sqlite3`, or `tedious` for SQL Server).

## Relationship to other packages
- Depends on `@tenora/core` for shared CLI + factory internals.
- Can be installed and used independently by end users.
