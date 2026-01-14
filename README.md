# Tenora

A framework-agnostic multi-tenant toolkit for Node.js (Knex + Objection). Tenora handles per-tenant database provisioning, secure credential handling, cached connections, and ready-made CLI commands for migrating and rolling back both base and tenant databases.

## Why Tenora?
- Works with any HTTP framework (Fastify, Express, Koa, Nest adapters, custom servers).
- Keeps tenants isolated at the database level (one DB per tenant, optional per-tenant DB user).
- Zero lock-in: you choose how to resolve tenant IDs and enforce authorization.
- Batteries included: password generation/encryption helpers and a CLI (`tenora`) for base/tenant migrations.

## Installation
```bash
npm install tenora
# peers: knex, objection, pg (install if not already in your project)
```

## Core concepts
- **Base database**: shared metadata (e.g., tenant registry). Tenora connects via a base Knex config.
- **Tenant database**: one Postgres database per tenant. Tenora can create it, create a dedicated DB user, and run tenant migrations/seeds.
- **Tenant resolver**: your middleware hook that picks the tenant ID per request and attaches a tenant-bound Knex instance.
- **Cache**: Tenora caches Knex instances per tenant to avoid pool churn; you can destroy them explicitly when needed.

## Quick start (programmatic)
```ts
import { createTenoraFactory, createTenantResolver, generateTenantPassword } from "tenora";

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

Commands:
- `tenora migrate` (alias `migrate:base`) / `tenora rollback` (alias `rollback:base`)
- `tenora migrate:tenants` / `tenora rollback:tenants`
- `tenora list` (help)

### CLI config (tenora.config.js by default)
```js
// tenora.config.js
import { decryptPassword } from "tenora";
import Tenants from "./models/Tenants"; // your data source for tenant ids/passwords

export default {
  base: {
    host,
    port: 5432,
    user,
    password,
    database: "base",
    migrationsDir: "migrations/base",
    seedsDir: "seeds/base", // optional
  },
  tenant: { migrationsDir: "migrations/tenants", seedsDir: "seeds/tenants" },
  listTenants: async () =>
    Tenants.query().select("id", "db_password as encryptedPassword"),
  decryptPassword: (enc) => decryptPassword(enc, process.env.CIPHER_KEY),
};
```
Run with a custom file: `tenora migrate:tenants --config path/to/file.js`.

## API surface
- `createTenoraFactory(options)` (alias `createKnexFactory`) → `{ getBase, getTenant, createTenantDb, destroyTenant, destroyAll }`
  - `options.base`: Postgres connection + optional migrations/seeds dirs
  - `options.tenant`: migrationsDir, seedsDir, userPrefix (defaults to `user_`), pool/ssl overrides
- `createTenantResolver({ manager, tenantId, passwordProvider?, authorizer?, attach? })`
  - Returns async `(req) => { tenantId?, knex? }`
  - Default attaches `req.tenantId` and `req.knex`; customize via `attach`
- Password helpers: `generateTenantPassword()`, `encryptPassword(password, key)`, `decryptPassword(ciphertext, key)`

## Typical lifecycle
1) **Bootstrap**: create factory once at app start.
2) **Provision**: `createTenantDb(tenantId, password?)` when a new tenant signs up.
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
