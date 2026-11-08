# Tenora

A framework-agnostic multi-tenant toolkit for Node.js with a standalone CLI and shared core internals.

This repository is the **Tenora monorepo**. It contains the runtime package, the CLI package, and a shared core package used by both.

## Why a monorepo?
- Keeps runtime and CLI behavior in sync.
- Allows cross-package refactors without breaking public APIs.
- Makes release/versioning simpler with Changesets.

## Which version?

| | 0.x | 1.0 canary |
| --- | --- | --- |
| What it is | the stable line, on Knex and Objection | a rewrite on Tenora's own ORM, `@tenora/orm` |
| Install | `npm install @tenora/multi-tenant` | `npm install @tenora/multi-tenant@canary` |
| npm tag | `latest` | `canary` |
| Branch | `development`, `main` | `next` |

The canary is a very large change and may have serious problems, so nothing installs it unless you ask for it by name.
Use it in projects you are willing to fix by hand. Relations, the tenant context and `tenora upgrade` are not in it yet,
and a project with Knex migrations cannot move to it until `tenora upgrade` exists. See
[the plan](docs/orm/plan.md).

## Packages
- **`@tenora/multi-tenant`**: runtime toolkit for your app code (tenant resolver, factory, password helpers).
- **`@tenora/cli`**: standalone `tenora` command for migrations/seeds and tenant-wide operations.
- **`@tenora/core`**: shared internals used by the two public packages.
- **`@tenora/orm`**: the query builder, models, schema builder and migrator behind the 1.0 canary.

## Which package should I install?
- Building an application/service: install `@tenora/multi-tenant`.
- Running CLI globally: install `@tenora/cli` globally.
- Running CLI locally in a project: install `@tenora/cli` in the project.
- Most users should not depend on `@tenora/core` directly.

## Installation examples
Runtime package:

```bash
npm install @tenora/multi-tenant
```

Standalone CLI globally:

```bash
npm install -g @tenora/cli
```

Standalone CLI in a project:

```bash
npm install -D @tenora/cli
npx tenora list
```

## Package docs
- Runtime docs: `packages/multi-tenant/README.md`
- CLI docs: `packages/cli/README.md`
- Core docs: `packages/core/README.md`

## Repository structure
```text
packages/
  core/          # shared internals (factory internals, config loading, registry helpers, CLI modules)
  multi-tenant/  # runtime API package
  cli/           # standalone tenora CLI package
```

## Local development
Install dependencies:

```bash
npm install
```

Build all packages:

```bash
npm run build
```

Create local tarballs for all packages:

```bash
npm run pack
```

## Testing
The tests run the built `tenora` binaries inside a throwaway project and check the results over a separate database connection, so a pass means the database really changed.

```bash
npm test
```

SQLite always runs. Postgres and MySQL run on temporary servers started from local `initdb`/`mysqld` binaries, on random ports, and never touch a database you already have. The schema dump tests also need `pg_dump` and `mysqldump`; without them those tests are skipped locally and fail in CI. In Docker mode they run inside each database container, so their versions always match.

To test the newest Postgres, MySQL, MariaDB and SQL Server versions in Docker:

```bash
npm run test:docker
```

To test against a server of your own, set any of `TENORA_TEST_PG_URL`, `TENORA_TEST_MYSQL_URL`, `TENORA_TEST_MARIADB_URL` or `TENORA_TEST_MSSQL_URL` to an admin URL such as `postgres://postgres:password@127.0.0.1:5432`. A server that has neither a URL nor local binaries is skipped, and the run prints which ones were.

## Release workflow
Tenora uses Changesets.

Create a changeset:

```bash
npm run changeset
```

Apply versions:

```bash
npm run version
```

Publish:

```bash
npm run release
```

In CI, publish is triggered on `main` via GitHub Actions.

## Compatibility notes
- All packages require Node.js 24.15 or newer.
- `@tenora/multi-tenant` still exposes a `tenora` binary in the current release line for backwards compatibility.
- New projects should install CLI from `@tenora/cli`.
- When using globally installed `@tenora/cli`, install your database driver in each target project (for example `pg` for Postgres).
