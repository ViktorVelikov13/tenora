# Tenora

A framework-agnostic multi-tenant toolkit for Node.js (Knex + Objection). Tenora handles per-tenant database provisioning, secure credential handling, cached connections, and ready-made CLI commands for migrating and rolling back both base and tenant databases.

## Why Tenora?
- Works with any HTTP framework (Fastify, Express, Koa, Nest adapters, custom servers).
- Keeps tenants isolated at the database level (one DB per tenant, optional per-tenant DB user).
- Zero lock-in: you choose how to resolve tenant IDs and enforce authorization.
- Batteries included: password generation/encryption helpers and a CLI (`tenora`) for base/tenant migrations.

## Installation
```bash
npm install @tenora/multi-tenant
# install the DB driver you use: pg, mysql2, mariadb, sqlite3, better-sqlite3, or tedious for SQL Server
```

## Core concepts
- **Base database**: shared metadata (tenant registry). Tenora connects via a base Knex config and stores tenants in a registry table.
- **Tenant database**: one Postgres database per tenant. Tenora can create it, create a dedicated DB user, and run tenant migrations/seeds.
- **Tenant resolver**: your middleware hook that picks the tenant ID per request and attaches a tenant-bound Knex instance.
- **Cache**: Tenora caches Knex instances per tenant to avoid pool churn; you can destroy them explicitly when needed.

## Quick start (programmatic)
```ts
import { createTenoraFactory, createTenantResolver, generateTenantPassword } from "@tenora/multi-tenant";

// 1) Create the factory at startup
// Option A: rely on tenora.config.js (default) or TENORA_CONFIG
const manager = createTenoraFactory();

// Option B: pass options inline
// const manager = createTenoraFactory({
//   base: { host, port: 5432, user, password, database: "base" },
//   tenant: { migrationsDir: "migrations/tenants", seedsDir: "seeds/tenants" }, // seeds optional
// });

// 2) Provision a tenant (one-off when signing up)
const pwd = generateTenantPassword();
await manager.createTenantDb("tenantA", pwd); // creates DB, user_userA, runs tenant migrations

// 3) Per-request hookup (framework-agnostic)
const resolveTenant = createTenantResolver({
  manager,
  tenantId: (req) => req.params.tenantId ?? req.headers["x-tenant-id"],
  passwordProvider: (tenantId) => lookupPlainOrDecrypt(tenantId), // optional
  authorizer: (tenantId, req) => ensureAccess(req.userId, tenantId), // optional
  // attach is optional; default sets req.tenantId and req.knex
});

await resolveTenant(req);
// Now use Objection with the tenant-bound Knex:
await SomeModel.query(req.knex).where(...);
```

## Built-in CLI (`tenora`)
Tenora ships with a CLI for migrations and rollbacks.
For new projects, prefer installing `@tenora/cli` (standalone package).
`@tenora/multi-tenant` keeps `tenora` for backwards compatibility.

Commands:
- `tenora migrate` (alias `migrate:base`) / `tenora rollback` (alias `rollback:base`)
- `tenora migrate:tenants` / `tenora rollback:tenants`
- `tenora schema:dump:tenants [--prune] [--check]` (see [Schema dumps](#schema-dumps))
- `tenora drop:tenant <id> --force`
- `tenora make:migration <name>` (alias `make:migration:base`) / `tenora make:migration:tenants <name>`
- `tenora make:seed <name>` (alias `make:seed:base`) / `tenora make:seed:tenants <name>`
- `tenora seed:run` (alias `seed:run:base`) / `tenora seed:run:tenants`
- `tenora list` (help)

Options:
- `--create-base`: create the base database (from `base.database`) if it does not exist.
- `--force`: required by `drop:tenant`, which permanently deletes the tenant.
- `--allow-unregistered`: let `drop:tenant` remove a tenant that is missing from the registry.
- `--prune`: let `schema:dump:tenants` delete the migration files the new dump contains.
- `--check`: make `schema:dump:tenants` only check that the dump is up to date, without a database.

Notes:
- `make:migration:*` requires the corresponding `migrationsDir`.
- `make:seed:*` and `seed:run*` require the corresponding `seedsDir`.
- Template output is auto-selected based on the nearest `package.json` (`"type": "module"` → ESM, otherwise CJS).
- Use `--esm` or `--cjs` to override template output for `make:migration:*` and `make:seed:*`.
- Migration templates infer common patterns:
  - `create_users` / `create_users_table` → `createTable("users")`
  - `add_email_to_users` → `alterTable("users").addColumn("email")`
  - `remove_email_from_users` / `drop_email_from_users` → `alterTable("users").dropColumn("email")`

### Multiple DBMS
Set `base.client` to the Knex client you want (e.g., `"pg"`, `"mysql2"`, `"mariadb"`, `"sqlite3"`, `"mssql"`). Tenora uses the
same client for tenant connections. Use `base.connection` when the driver needs non-standard fields (e.g., `server` for SQL Server
or `filename` for SQLite).

`createTenantDb`, `dropTenantDb` and `--create-base` support **Postgres**, **MySQL/MariaDB**, **SQLite**, and **SQL Server**. For other drivers,
provision the base and tenant databases externally and Tenora will connect to them.

### CLI config (tenora.config.js by default)
```js
// tenora.config.js
import { defineTenoraConfig, decryptPassword, encryptPassword } from "@tenora/multi-tenant";

export default defineTenoraConfig({
  base: {
    client: "pg", // or "mysql2"
    host,
    port: 5432,
    user,
    password,
    database: "base",
    // adminDatabase: "postgres", // optional override for create-base/create-tenant
    // connection: { /* full Knex connection config override (useful for sqlite/mssql) */ },
    migrationsDir: "migrations/base",
    seedsDir: "seeds/base", // optional
  },
  tenant: { migrationsDir: "migrations/tenants", seedsDir: "seeds/tenants" },
  // Optional: customize where tenant records live (default: tenora_tenants)
  registry: { table: "tenora_tenants" },
  encryptPassword: (plain) => encryptPassword(plain, process.env.CIPHER_KEY),
  decryptPassword: (enc) => decryptPassword(enc, process.env.CIPHER_KEY),
});
```
Run with a custom file: `tenora migrate:tenants --config path/to/file.js`.
Default lookup order: `tenora.config.js`, `tenora.config.mjs`, `tenora.config.ts` (unless `TENORA_CONFIG` is set).

Tip: use `defineTenoraConfig(...)` in your config file to get IDE hints for all options.
If your config is `.mjs` or `.ts` and you want to load it implicitly in code, use `createTenoraFactoryAsync()`
or import the config and pass it directly to `createTenoraFactory(...)`.

Encryption defaults:
- If `encryptPassword`/`decryptPassword` are not provided, Tenora will use `process.env.TENORA_KEY` (if set).
- If no key is present, Tenora stores plaintext passwords in the registry.
- `encryptPassword` uses AES-256-GCM from Node's built-in `crypto` and writes values starting with `tenora:v1:`.
- `decryptPassword` also reads values written by Tenora 0.3 and earlier (they start with `U2FsdGVkX1`), so existing registry entries keep working without re-encrypting. Tenora 0.3 cannot read the new format, so downgrading after creating tenants needs those passwords re-encrypted.

SQLite notes:
- For SQLite, set `base.database` to a file path or provide `base.connection.filename`.
- Tenant DB files default to `<cwd>/<tenantId>.sqlite`; customize with `tenant.databaseDir`, `tenant.databaseSuffix`, or `tenant.databaseName`.

### Tenant registry (auto-migration)
Tenora stores tenants in a **registry table** in your base DB. The CLI will **auto-generate** a base migration
the first time you run `tenora migrate` (or `migrate:base`). This gives you a file you can **rename or edit**
before applying it.
Make sure `base.migrationsDir` is set so Tenora knows where to write the migration.

Defaults (customizable via `registry`):
- table: `tenora_tenants`
- columns: `id`, `password`, `encrypted_password`, `created_at`, `updated_at`

If you rename the table or columns in the generated migration, update `registry` in your config to match.
If `encryptPassword` is provided, Tenora stores the encrypted value in `encrypted_password`; otherwise it stores the plain password in `password`.

### Schema dumps
With many tenant migrations, creating a tenant gets slow, because `createTenantDb` runs every migration one by one.
A schema dump stores the structure those migrations produce, so a new tenant database is built in one go:

```bash
tenora schema:dump:tenants
```

This creates a throwaway database, runs every tenant migration on it, and writes its structure to
`schema/tenant-<dialect>.sql` next to your tenant migrations directory (for example `migrations/schema/tenant-postgres.sql`),
then drops the throwaway database. The dump holds no data except Knex's record of which migrations it contains.
Commit it alongside your migrations.

When the dump exists, `createTenantDb` loads it into the new, empty database as the tenant's own user, then runs only the
migrations newer than the dump, then the seeds. Existing tenants and `migrate:tenants` are unaffected. Without a dump file,
nothing changes.

- **Keep it current**: run `tenora schema:dump:tenants` again after adding migrations. It starts from the previous dump, so it
  also works after pruning. In CI, `tenora schema:dump:tenants --check` fails when a migration file is missing from the dump;
  it only reads files, so it needs no database.
- **Prune**: `tenora schema:dump:tenants --prune` also deletes the migration files the dump now contains. Tenora keeps listing
  them for Knex, so existing tenants keep migrating, but they can no longer be rolled back. **Run `migrate:tenants` everywhere
  before pruning**: a tenant that never ran a pruned migration stops with an error until you restore that file from version
  control and migrate it.
- **Tools**: dumping uses `pg_dump` for Postgres and `mysqldump` or `mariadb-dump` for MySQL/MariaDB, which must be at least
  as new as the server. Set `TENORA_PG_DUMP`, `TENORA_MYSQLDUMP` or `TENORA_MARIADB_DUMP` to use a specific binary. SQLite
  needs no tool. Loading needs no tools at all, so application servers do not need them.
- **SQL Server** has no schema dumps; its tenants keep running every migration.
- **Configuration**: set `tenant.schemaFile` to put the dump elsewhere, or to `false` to never load one.

There is no built-in scheduler, because the dump only changes when migrations change. To refresh it automatically, run it in CI
and open a pull request when it changed, for example with GitHub Actions:

```yaml
on:
  push:
    branches: [main]
jobs:
  schema-dump:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env: { POSTGRES_PASSWORD: postgres }
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24 }
      - run: npm ci
      # The runner's own pg_dump is older than Postgres 18, so install a matching one.
      - run: |
          sudo apt-get update
          sudo apt-get install -y postgresql-common
          sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
          sudo apt-get install -y postgresql-client-18
      - run: npx tenora schema:dump:tenants # with a tenora.config.js pointing at the service above
        env:
          TENORA_PG_DUMP: /usr/lib/postgresql/18/bin/pg_dump
      - uses: peter-evans/create-pull-request@v8
        with: { title: "Update tenant schema dump", branch: tenant-schema-dump }
```

Programmatically, the same is `manager.dumpTenantSchema({ prune })` and `checkTenantSchemaDump(options)`.

## API surface
- `createTenoraFactory(options)` (alias `createKnexFactory`) → `{ getBase, getTenant, createTenantDb, dropTenantDb, destroyTenant, destroyAll }`
- `createTenoraFactoryAsync(options)` → same, but can load `.mjs`/`.ts` config files via default lookup
  - `options.base`: base connection (any Knex client) + optional migrations/seeds dirs
  - `options.tenant`: migrationsDir, seedsDir, userPrefix (defaults to `user_`), pool/ssl overrides, SQLite db path options
- `dropTenantDb(tenantId, { allowUnregistered? })` permanently deletes the tenant database, its user and its registry entry
  - Open connections to the tenant database are closed first
  - Rejects tenants missing from the registry, so a mistyped ID cannot delete an unrelated database; pass `allowUnregistered: true` to clear a half-created tenant
  - Always refuses the base database and system databases
  - Do not call it with a tenant ID taken directly from a request
- `dumpTenantSchema({ prune? })` writes the tenant schema dump and returns `{ file, migrations, pruned }` (see [Schema dumps](#schema-dumps))
- `checkTenantSchemaDump(options)` returns `{ file, exists, missing }` without connecting to a database
- `destroyTenant(tenantId)` only closes the cached connection pool; the database itself is untouched
- `createTenantResolver({ manager, tenantId, passwordProvider?, authorizer?, attach? })`
  - Returns async `(req) => { tenantId?, knex? }`
  - Default attaches `req.tenantId` and `req.knex`; customize via `attach`
- Password helpers: `generateTenantPassword()`, `encryptPassword(password, key)`, `decryptPassword(ciphertext, key)`

## Typical lifecycle
1) **Bootstrap**: create factory once at app start.
2) **Provision**: `createTenantDb(tenantId, password?)` when a new tenant signs up (also writes to registry table).
3) **Store creds**: save encrypted tenant DB password in your base DB.
4) **Request flow**: middleware runs `createTenantResolver` → attaches `req.knex` for Objection queries.
5) **Migrate**: use CLI to keep base and tenant schemas in sync.
6) **Offboard**: `dropTenantDb(id)` or `tenora drop:tenant <id> --force` when a tenant leaves.
7) **Shutdown/cleanup**: call `destroyTenant(id)` or `destroyAll()` to close pools.

## Security notes
- Use per-tenant DB users with strong passwords (generate + encrypt).
- Keep the AES key (`CIPHER_KEY`) outside source control.
- Authorize tenant access in the resolver (`authorizer` hook) to prevent cross-tenant leakage.
- Rotate tenant passwords by recreating the DB user and updating stored (encrypted) password.

## Troubleshooting
- **“database already exists”**: a previous `createTenantDb` may have failed partway, leaving a tenant that is not in the registry. Remove it with `tenora drop:tenant <id> --force --allow-unregistered`, or pick a new ID.
- **“password authentication failed”**: ensure `passwordProvider` returns the plain password for that tenant.
- **“could not decrypt the tenant password”**: the cipher key (`TENORA_KEY` or your own) is not the one the password was encrypted with.
- **Migrations not running**: verify `tenant.migrationsDir` is correct and reachable from where you invoke the CLI.
- **Pooling issues**: adjust `tenant.pool` or `base.pool` in the factory options.

## Minimum example config snippet
```ts
const factory = createTenoraFactory(); // uses tenora.config.js or TENORA_CONFIG path
// or pass inline options as above if you prefer
```

Tenora stays independent of any specific app domain—use it in any Node.js service that needs clean, per-tenant Postgres isolation with Knex + Objection.
