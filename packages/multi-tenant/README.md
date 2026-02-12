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
# install the DB driver you use (for example: pg, mysql2, mariadb, sqlite3, mssql)
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
- `tenora make:migration <name>` (alias `make:migration:base`) / `tenora make:migration:tenants <name>`
- `tenora make:seed <name>` (alias `make:seed:base`) / `tenora make:seed:tenants <name>`
- `tenora seed:run` (alias `seed:run:base`) / `tenora seed:run:tenants`
- `tenora list` (help)

Options:
- `--create-base`: create the base database (from `base.database`) if it does not exist.

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

`createTenantDb` and `--create-base` support **Postgres**, **MySQL/MariaDB**, **SQLite**, and **SQL Server**. For other drivers,
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

## API surface
- `createTenoraFactory(options)` (alias `createKnexFactory`) → `{ getBase, getTenant, createTenantDb, destroyTenant, destroyAll }`
- `createTenoraFactoryAsync(options)` → same, but can load `.mjs`/`.ts` config files via default lookup
  - `options.base`: base connection (any Knex client) + optional migrations/seeds dirs
  - `options.tenant`: migrationsDir, seedsDir, userPrefix (defaults to `user_`), pool/ssl overrides, SQLite db path options
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
6) **Shutdown/cleanup**: call `destroyTenant(id)` or `destroyAll()` to close pools.

## Security notes
- Use per-tenant DB users with strong passwords (generate + encrypt).
- Keep the AES key (`CIPHER_KEY`) outside source control.
- Authorize tenant access in the resolver (`authorizer` hook) to prevent cross-tenant leakage.
- Rotate tenant passwords by recreating the DB user and updating stored (encrypted) password.

## Troubleshooting
- **“database already exists”**: your registry may have stale tenants; drop or pick a new ID.
- **“password authentication failed”**: ensure `passwordProvider` returns the plain password for that tenant.
- **Migrations not running**: verify `tenant.migrationsDir` is correct and reachable from where you invoke the CLI.
- **Pooling issues**: adjust `tenant.pool` or `base.pool` in the factory options.

## Minimum example config snippet
```ts
const factory = createTenoraFactory(); // uses tenora.config.js or TENORA_CONFIG path
// or pass inline options as above if you prefer
```

Tenora stays independent of any specific app domain—use it in any Node.js service that needs clean, per-tenant Postgres isolation with Knex + Objection.
