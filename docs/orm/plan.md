# Tenora ORM: plan for 1.0

Status: proposal, nothing built yet; the open decisions were settled on 2026-11-07 (see [Decisions](#decisions)).
The research behind it, with sources, is in [research.md](research.md).

## Summary

Tenora 1.0 adds `@tenora/orm`, an Eloquent-inspired ORM written for Tenora, and removes Knex and Objection from every
package. Its central idea is the one the current setup lacks: **the connection and the open transaction are ambient**.
A model knows whether it lives in the base or the tenant database, the request knows which tenant it serves, and every
query inside `transaction(async () => …)` joins that transaction without a handle being passed around.

```ts
// 0.x with Objection: every query needs the tenant knex, and every query in a transaction needs trx
await Order.transaction(req.knex, async (trx) => {
  const order = await Order.query(trx).insert({ customerId });
  await order.$relatedQuery("items").insert(items); // forgot trx: runs outside the transaction, no error
  await Stock.query(req.knex).decrement("qty", 1);  // same mistake, different spelling
});

// 1.0: the tenant comes from the request, the transaction from the callback
await transaction(async () => {
  const order = await Order.create({ customerId });
  await order.items().createMany(items);
  await Stock.where("sku", sku).decrement("qty", 1);
});
```

The 0.x line keeps getting fixes for a defined window. A `tenora upgrade` command moves existing projects over: it
copies the migration history of the base and every tenant from Knex's bookkeeping to Tenora's own `tenora_migrations`
table, converts Knex migration and seed files to Tenora's format (proving they build the same schema), and converts
Objection models and the code that calls them.

## What 0.x depends on today

The coupling is to **Knex**, not to Objection. Objection appears only in the README, `package.json`, the tsdown externals
and one test; Tenora never calls it. Users bring Objection themselves and pass Tenora's Knex into it. Replacing Knex
means replacing all of this:

| Area | Where | What Knex does |
| --- | --- | --- |
| Connections and pools | `core/src/factory/build.ts` | `knex(config)` per base, admin and tenant connection; tenant cache |
| Public API | `TenantManager.getBase()/getTenant()`, `createTenantResolver` | return `Knex` instances; `req.knex` |
| Provisioning | `build.ts`, `cli/database.ts` | `admin.raw(...)` for `CREATE DATABASE`, users and grants on 4 dialects |
| Registry | `tenantRegistry.ts` | query builder, `onConflict().merge()`, `schema.hasTable` |
| Migrations | CLI commands, `createTenantDb` | `migrate.latest/rollback/make`, the `knex_migrations` tables |
| Seeds | CLI commands, `createTenantDb` | `seed.run/make` |
| Schema dumps | `schemaFile.ts`, `schemaSql.ts` | Knex's internal `FsMigrations`, its migration table, raw driver connections |
| Driver lookup | `runtime/resolveKnex.ts` | resolving `knex` and drivers from the project's `node_modules` for global CLI installs |
| Config | `MultiTenantOptions` | `knexOptions`, `Knex.PoolConfig`, `Knex.ConnectionConfig` types |

On the user's side, outside our code, **their migration and seed files are Knex code**
(`exports.up = (knex) => knex.schema.createTable(…)`), and their models are Objection classes. The plan answers both.

## Goals and non-goals

Goals:

1. An ORM with Eloquent's ergonomics (models, relations, eager loading, scopes, casts, events, soft deletes, pagination)
   and TypeScript types that catch wrong column names.
2. Transactions that are hard to get wrong: ambient, nestable (savepoints), with `afterCommit` hooks and deadlock retries.
3. Multi-tenancy built in: models declare `base` or `tenant`; a tenant model with no current tenant throws instead of
   silently using another database.
4. No Knex or Objection in any package's dependencies, and Tenora's own migration bookkeeping. One engine for the ORM,
   the CLI, provisioning and migrations.
5. Every database 0.x supports, all in 1.0: Postgres, MySQL, MariaDB, SQLite, SQL Server.
6. A tested, reversible upgrade from 0.x that converts the project's code as well as its databases, and a maintained 0.x
   line while people move.
7. Node 24.15 or newer.

Non-goals for 1.0: a Unit of Work or identity map (MikroORM style), transactions spanning two databases, polymorphic
relations, model factories, generating models from the database (all but the second are planned for 1.x, see
[Phases](#phases)).

## Packages

```text
packages/
  orm/            @tenora/orm           new: drivers, pool, transactions, query builder, schema builder, migrator, models
  core/           @tenora/core          provisioning, registry, schema dumps, CLI modules, now on @tenora/orm
  multi-tenant/   @tenora/multi-tenant  runtime: factory, tenant context, middleware; re-exports @tenora/orm
  cli/            @tenora/cli           the tenora binary, plus `tenora upgrade`
  upgrade/        @tenora/upgrade       new: migration, seed and model converters and the schema proof, used by `tenora upgrade`
```

This puts the ORM *underneath* the tenancy packages, not on top of `@tenora/multi-tenant`, because core needs the same
engine to provision tenants and run migrations, and an ORM on top would make that a circular dependency. Users still see
it the other way round: they install `@tenora/multi-tenant` and get the ORM with tenancy built in.

`@tenora/orm` does not depend on the tenancy packages. Like Eloquent asking Laravel's `DatabaseManager` for a connection
by name, a model asks a **connection resolver** for `"base"` or `"tenant"`, and `@tenora/multi-tenant` registers the
resolver that knows the current tenant. This keeps the dependency direction one way (`orm ← core ← multi-tenant, cli`),
lets core use the same engine for provisioning and migrations, and keeps the ORM testable on its own.

Users install `@tenora/multi-tenant` (which brings the ORM) and their driver, and `@tenora/upgrade` as a dev dependency
only while they upgrade. The new packages join the Changesets `fixed` group, so all five release together as 1.0.0.

## The engine

**Decision: a hybrid.** Tenora owns everything users see and everything that decides correctness: the query
builder API, the dialect rules, connections, pools, transactions, the migrator and the models. **Kysely is used only to
turn a query into SQL text and parameters**, through its documented compile-only mode (`Kysely<any>` with a
`DummyDriver`, then `.compile()`), never to run queries. This is the split MikroORM 7 and ZenStack 3 use today.

Why not write the SQL compiler too: it is roughly 10–14k lines (Kysely's core is 14k, Knex 18.5k) that would recreate
quoting, parameter numbering and DDL compilation for no gain to users. Why not use Kysely as the whole engine: its
transaction layer has no nesting and was still getting fixes in October and November 2026, its migrator has no batches
and its own table names, it has no SQLite table rebuild, and it does not support the `mariadb` driver or `node:sqlite`.
And Kysely compiles whatever it is asked to, per dialect, without refusing SQL a database will reject (`LIMIT` on SQL
Server, `RETURNING` on MySQL), so the dialect decisions are Tenora's under any option. Details in
[research.md](research.md#6-build-or-wrap).

Checked locally: Kysely 0.29.8 type-checks under the repo's TypeScript 7.0.2 with `skipLibCheck` off, and
compiles queries and DDL for Postgres, MySQL, SQL Server and SQLite with no database. MariaDB uses the MySQL compiler,
which needs nothing else, since quoting and placeholders are the same. A second check compiled the syntax that only some
databases have, for all five: upserts (`ON CONFLICT`, `ON DUPLICATE KEY UPDATE … VALUES()`, `MERGE … OUTPUT`),
`RETURNING` on MariaDB, `OUTPUT` and `TOP` on SQL Server, `FOR UPDATE SKIP LOCKED`, JSON paths, and per-dialect DDL
(`IDENTITY`, `AUTO_INCREMENT`, `MODIFY COLUMN`, `ALTER COLUMN`). Two constructs came out in the wrong order and are
written by Tenora's dialect layer as `sql` templates instead: MySQL's row-alias upsert (`VALUES (…) AS new ON DUPLICATE
KEY UPDATE …`) and SQL Server table hints (`FROM users AS u WITH (UPDLOCK)`).

So the engine supports every database Tenora supports today. Our own SQL compiler is the fallback, written only for a
construct a dialect needs that neither Kysely nor a `sql` template inside the dialect layer can produce; the `compile()`
boundary below lets that replace Kysely one dialect at a time.

Containing the dependency:

- Kysely is used in exactly one internal module, `compile(query, dialect) → { sql, parameters }`, and is pinned to an exact
  version (it is 0.x, and minors break).
- Every dialect has compile snapshot tests, so upgrading Kysely is a reviewed diff, and replacing it with our own compiler
  later stays possible without touching anything else.
- Kysely has no dependencies of its own. It is invisible in Tenora's public API and types.

Layers, bottom up:

| Layer | Owner | Responsibility |
| --- | --- | --- |
| Driver adapters | Tenora | `pg`, `mysql2`, `mariadb`, `better-sqlite3`, `node:sqlite`, `tedious`: connect, query, stream, close; map errors to typed errors (unique violation, deadlock, serialization failure, …) |
| Pools | Tenora | the driver's own pool where it has one (`pg.Pool`, `mysql2`, `mariadb`); a small built-in pool for `tedious`; one serialized connection for SQLite; per-tenant pools with idle eviction |
| Connections and transactions | Tenora | run SQL, own the transaction state (level, savepoints, after-commit callbacks), queue queries per connection, query events for logging |
| Query builder | Tenora | fluent Eloquent-style builder: `where*`, joins, aggregates, grouping, locking (`forUpdate`, `skipLocked`), `upsert`, `insertGetId`, unions, subqueries, `sql` tagged fragments |
| Dialect rules | Tenora | per dialect: paging (`LIMIT/OFFSET`, `OFFSET…FETCH`), `RETURNING` vs `OUTPUT` vs `insertId`, upsert flavour (`ON CONFLICT`, `ON DUPLICATE KEY`, `MERGE`), JSON paths, boolean and date codecs, MariaDB differences, SQLite table rebuild |
| SQL compilation | Kysely, behind `compile()` | identifiers, placeholders, statement text for queries and DDL |
| Schema builder | Tenora | Laravel-style blueprint (`t.id()`, `t.string()`, `t.foreignId().constrained()`, `t.timestamps()`), plus a Knex-compatible blueprint for converted migrations; catalog introspection for the schema proof; compiled through the same module |
| Migrator and seeder | Tenora | `tenora_migrations`, batches, locks, `.ts`/`.js`/`.sql` migrations, schema dumps |
| ORM | Tenora | models, attributes, casts, relations, eager loading, scopes, events, soft deletes, serialization, pagination |

Driver decisions:

- **`sqlite3` is dropped.** It is deprecated and its repository archived. SQLite projects switch to `better-sqlite3`
  (same database files, nothing to convert), and `tenora upgrade` reports a `client: "sqlite3"` config.
- **`node:sqlite`** (built into Node) is supported too: Node 24.15.0 marked it a release candidate
  ([#61262](https://github.com/nodejs/node/pull/61262)), which is one reason 1.0 requires Node 24.15.
- Dates and booleans are encoded by Tenora for SQLite: `better-sqlite3` throws on them, and `node:sqlite` silently
  stores a `Date` as `NULL`.
- **`mariadb`**: big integers and ids come back as `BigInt` by default; the adapter asks the driver for numbers instead,
  with decimals as exact strings, so results look the same as through `mysql2`.
- **SQL Server**: statements without parameters run as plain batches, because `sp_executesql` would undo
  `SET TRANSACTION ISOLATION LEVEL` and reject `BEGIN TRANSACTION`; an isolation level is reset to `READ COMMITTED`
  before the connection goes back to the pool, since on SQL Server it outlives the transaction.
- **`tedious`** needs a declared type for every parameter, so its adapter infers the TDS type from the JavaScript value,
  as Kysely's own SQL Server driver does.
- Drivers are resolved from the project's `node_modules` first, as `resolveKnex` does today, so a globally installed
  `@tenora/cli` keeps working.

## Connections and the tenant context

One `AsyncLocalStorage` holds one context object for the current async flow: the current tenant and the open
transactions, keyed by connection (`base`, `tenant:<id>`).

```ts
import { createTenora } from "@tenora/multi-tenant";

const tenora = await createTenora(); // reads tenora.config.js, same format as 0.x

// Per request, framework-agnostic: everything after it sees the tenant.
// Works as Express middleware (next) and as a Fastify onRequest hook (done).
app.use(tenora.middleware({ tenantId: (req) => req.headers["x-tenant-id"], authorizer }));

// Outside requests: jobs, scripts, tests
await tenora.tenant("acme").run(async () => {
  await User.where("active", false).delete();
});

// Explicit, no context needed
await User.on(tenora.tenant("acme")).where("active", false).delete();
```

How a query picks where to run is two separate questions, answered in order.

**Which database** (the connection key), first match wins:

1. An explicit connection: `User.on(conn)`, or the connection of an explicit `User.using(trx)`.
2. The database a model instance was loaded from: `user.save()` and `user.posts().create(…)` go to the database `user`
   came from, even if the context has changed since.
3. The model's declared connection: `static connection = "base"` → the base database; `"tenant"` → the current tenant.
4. Otherwise it throws `NoTenantError`. A tenant model never falls back to the base or a default database.

**Which transaction**, for that database:

1. An explicit `using(trx)`, on the query or pinned on the instance with `user.using(trx)`.
2. Otherwise the transaction open on that database in the current context, if there is one.
3. Otherwise a pooled connection, outside any transaction.

So an instance remembers its **database, not its transaction**. A `User` loaded before `transaction()` started and saved
inside it joins the transaction; one loaded inside a transaction and saved after it committed simply runs outside it,
instead of failing on a closed transaction. (Objection forgets the database as well as the transaction, which is how
`p.$relatedQuery("pets").insert(…)` escapes there. Lucid pins the transaction on the instance, which breaks the second
case.) Only an explicit `using(trx)` pins a transaction.

This is Spatie's landlord/tenant model (`UsesLandlordConnection` / `UsesTenantConnection`) with the current tenant carried
by `AsyncLocalStorage` instead of a process-wide value, which is what broke under Laravel Octane.

Rules for the context itself:

- Only `run()` is used, never `enterWith()`, whose behaviour changed in Node 24 and which leaks into later work.
- The context is read once, when the query is executed from user code, and the resolved connection is passed down
  explicitly. Driver and pool callbacks never read it: they can run in a stale context (a known `pg-pool` issue).
- Tenant pools are created lazily per tenant and closed after an idle timeout, so a process serving many tenants does not
  hold a pool for each of them.

## Transactions

```ts
import { transaction, afterCommit, withoutTransaction } from "@tenora/orm";

// 1. Ambient: every query on the tenant connection inside the callback joins the transaction,
//    including queries run by model events and observers.
await transaction(async () => {
  const order = await Order.create({ customerId });
  await order.items().createMany(items);
  await Stock.where("sku", sku).decrement("qty", 1);
  afterCommit(() => mailer.send(new OrderPlaced(order))); // only after COMMIT; dropped on rollback
});

// 2. Retries: the whole callback runs again on deadlock or serialization failure (outermost level only).
await transaction(work, { attempts: 3, isolation: "serializable" });

// 3. Nesting: an inner transaction() is a savepoint. Its failure rolls back only to the savepoint.
await transaction(async () => {
  await Invoice.create(data);
  try {
    await transaction(() => LoyaltyPoints.award(customerId)); // SAVEPOINT
  } catch {
    // the points failed; the invoice still commits
  }
});

// 4. Which connection: transaction() uses the current tenant. Name another one explicitly.
await tenora.base.transaction(async () => { /* registry, plans, billing */ });

// 5. An explicit handle, for code that cannot use a callback
const trx = await tenora.tenant("acme").beginTransaction();
try {
  await User.using(trx).create(data);
  await trx.commit();
} catch (error) {
  await trx.rollback();
  throw error;
}

// 6. A write that must survive a rollback
await withoutTransaction(() => AuditLog.create({ event: "payment_failed" }));
```

Rules, decided up front:

- **One physical connection per transaction**, taken from the pool for its lifetime. State (level, savepoints,
  after-commit callbacks) lives with that transaction, per connection. Laravel keeps after-commit callbacks in one
  manager shared by all connections, which can tie a tenant callback to a base commit; Tenora does not.
- **Tenora queues queries on a transaction's connection itself**, in the order they were issued, so `Promise.all` inside
  a transaction is safe. It does not rely on the driver: `pg` 9 drops its own queueing, and `tedious` allows only one
  request per connection.
- **Nothing escapes after the end.** Once a transaction commits or rolls back, queued and later queries on it fail with
  `TransactionClosedError`. They never fall back to the pool, where they would silently autocommit. This matters when
  one branch of a `Promise.all` fails and the rollback runs while the others are still issuing queries.
- **A commit is verified.** Postgres answers `COMMIT` with `ROLLBACK` when the transaction had already failed; Tenora
  reads the command tag and throws `TransactionAbortedError` instead of reporting success (Knex and Lucid both report
  success here). If the connection is lost during `COMMIT`, it throws `TransactionOutcomeUnknownError`. In both cases
  no after-commit callback runs.
- **Nesting** uses savepoints with a level counter. After-commit callbacks registered at any level run only when the
  outermost transaction commits; rolling back to a savepoint drops that level's callbacks. `afterCommit()` with no
  transaction open runs the callback straight away, as in Laravel. (Lucid runs them when the
  savepoint is released, which fires side effects for work that is later rolled back.) Two nested `transaction()` calls
  running at the same time inside one transaction run one after the other.
- **Retries** wrap only the outermost transaction, for errors the driver adapter classifies as deadlock or serialization
  failure (Postgres `40P01`/`40001`, MySQL/MariaDB `1213`, SQL Server `1205`, SQLite busy). A deadlock inside a nested
  transaction rethrows to the outermost one, as in Laravel, because MySQL has already rolled the whole transaction back.
  Unlike Laravel, retries wait a short jittered backoff.
- **`createOrFirst` and `firstOrCreate`** insert inside a savepoint when a transaction is open, so a unique violation does
  not poison a Postgres transaction (a Laravel detail worth copying).
- **Two databases, two transactions.** A request uses the base and a tenant database; one transaction cannot cover both,
  and Tenora does not pretend otherwise (no two-phase commit). Writing to a connection that has no open transaction while
  another connection has one logs a warning, and throws in `strict` mode, because that write will not roll back. The
  documented pattern: commit the tenant transaction, then write to the base in `afterCommit`, or use an outbox table in
  the tenant database.
- **Provisioning never joins a transaction.** `CREATE DATABASE` cannot run in one, and MySQL DDL commits implicitly.
  `createTenantDb` and `dropTenantDb` called inside `transaction()` throw a clear error (both Laravel tenancy packages
  get this as a confusing "no active transaction" error).
- Model events and observers can opt into running after commit (`static afterCommit = true`), as in Laravel.
- Mass `update()` and `delete()` on a query do not fire model events, as in Eloquent; the docs say so next to the events.

## Models

Static class fields, not decorators, so models work the same in plain JavaScript (0.x ships CJS and ESM templates
because many users write JavaScript) and need no `experimentalDecorators`.

```ts
import { Model, cast, scope } from "@tenora/orm";

export class User extends Model {
  static table = "users";              // default: snake_case plural of the class name
  static connection = "tenant";        // "tenant" | "base"
  static fillable = ["name", "email", "settings"] as const;
  static hidden = ["password"] as const;
  static casts = { settings: cast.json<UserSettings>(), isAdmin: "boolean", lastSeenAt: "datetime" } as const;
  static softDeletes = true;           // deleted_at, a global scope, withTrashed(), restore(), forceDelete()
  // timestamps are on by default: created_at, updated_at

  declare id: number;
  declare name: string;
  declare email: string;
  declare settings: UserSettings;

  posts() { return this.hasMany(Post); }
  team() { return this.belongsTo(Team); }
  roles() { return this.belongsToMany(Role).withPivot("grantedAt"); }
  plan() { return this.belongsTo(Plan); } // Plan lives in the base database; eager loading still works

  static active = scope((query) => query.where("active", true));

  static {
    this.creating((user) => { user.email = user.email.toLowerCase(); });
  }
}

const users = await User.query()
  .apply(User.active)
  .where("createdAt", ">", lastWeek)       // column names are checked against the model's fields
  .with("posts", (posts) => posts.latest().limit(5))
  .with("plan")                            // a WHERE IN query on the base connection
  .withCount("posts")
  .paginate({ page: 2, perPage: 20 });

const user = await User.findOrFail(id);
user.fill(body);                           // only fillable keys; unknown keys throw in strict mode
if (user.isDirty("email")) user.emailVerifiedAt = null;
await user.save();                         // UPDATE only the changed columns
```

What comes from Eloquent, and what changes for TypeScript and Node:

| Eloquent | Tenora | Note |
| --- | --- | --- |
| `$fillable` / `$guarded`, `fill`, `create` | same | typed `fill()` plus a runtime guard for untyped input |
| `casts()`, custom `CastsAttributes` | `static casts`, `cast.json<T>()`, custom `{ get, set }` | casts drive the field types |
| accessors/mutators (`Attribute::make`) | getters and setters on the class, or a cast | plain TypeScript, no proxies |
| timestamps, soft deletes | same | |
| local scopes (`#[Scope]`, `scopeActive`) | `static active = scope(…)`, `query.apply(User.active)` | typed, no magic method names |
| global scopes | `static globalScopes`, `withoutGlobalScope` | soft deletes is one |
| events, observers | `creating`, `saving`, `deleted`, …; `User.observe(UserObserver)` | async, awaited inside the transaction; `afterCommit` per observer |
| `isDirty`, `getOriginal`, `wasChanged` | same | compares cast values; `save()` writes only dirty columns |
| `firstOrCreate`, `createOrFirst`, `updateOrCreate`, `upsert` | same | savepoint around the insert inside transactions |
| relations, `with`, `load`, `loadMissing`, `withCount`, `whereHas` | same | `with("posts.comments")` paths are type-checked; `whereHas` across base and tenant throws, since it needs a subquery in one database |
| lazy loading `$user->posts` | `await user.load("posts")` or `await user.posts().get()` | property access cannot await; reading a relation that was not loaded throws |
| `preventLazyLoading`, `preventSilentlyDiscardingAttributes`, `preventAccessingMissingAttributes` | one `strict` switch, **on by default**, per Tenora instance | Eloquent's most common pitfalls become errors, without static globals |
| `chunkById`, `lazyById`, `cursor` | `chunkById`, `for await (const user of User.query().lazyById())`, `cursor()` | async iterators |
| `paginate`, `simplePaginate`, `cursorPaginate` | same | the page comes from the caller, not a global request |
| `toArray`, `$hidden`, `$visible`, `$appends` | `toJSON()` honours `hidden`, `visible`, `appends` | output type omits hidden fields |
| polymorphic relations, morph map | 1.x, with a **required** morph map | class names are not stable after minification |
| `DB::table()` query builder | `db.table("users")` | the same builder, without models |
| facades, static global state | context-scoped connections, injected instances | testable; no global `DB` |

Typing approach: a model's fields come from its `declare`d properties, so `where`, `orderBy`, `pluck` and `select`
accept those names (camelCase, mapped to snake_case columns by a naming strategy) with their value types, and `select`
narrows the result type. Joins and raw fragments accept plain strings. How far inference goes before it slows the
compiler on a large model set is prototyped and measured in phase 3, before the API is frozen.

## Migrations and seeds

New migrations use the blueprint schema builder:

```ts
import { migration } from "@tenora/orm";

export default migration({
  async up({ schema }) {
    await schema.create("orders", (t) => {
      t.id();
      t.foreignId("customer_id").constrained().cascadeOnDelete();
      t.decimal("total", 12, 2);
      t.json("meta").nullable();
      t.timestamps();
    });
  },
  async down({ schema }) {
    await schema.drop("orders");
  },
});
```

- Bookkeeping is Tenora's own, in every database (base and each tenant): `tenora_migrations (id, name, batch,
  migrated_at, source)` and `tenora_migrations_lock`, named like the existing `tenora_tenants` registry and configurable
  with `migrations.table`. The 1.0 migrator never reads or writes `knex_migrations`; the only code that reads it is
  `tenora upgrade`, once, to copy the history over (see [The upgrade command](#the-upgrade-command)). Batches work as
  today, so `rollback` keeps meaning "the last batch".
- The lock is a row in `tenora_migrations_lock`, as with Knex, rather than a Postgres session advisory lock (which is what
  Kysely's migrator uses and which breaks under PgBouncer transaction pooling).
- Each migration runs in its own transaction where the database supports transactional DDL (Postgres, SQLite, SQL
  Server); `migration({ transaction: false, … })` opts out. MySQL and MariaDB commit DDL implicitly, which the docs say.
- `.sql` files are migrations too, which is what a baseline from a schema dump is (see below).
- `migrate:tenants` runs tenants concurrently with `--concurrency <n>` (default 1, as today), each under its own lock,
  and prints a summary of failures instead of stopping at the first.
- Schema dumps keep their file format, with the migration list read from `tenora_migrations`. `schema:dump:base` is new
  (it is needed for the upgrade, below).
- `make:migration` generates the new format; the name inference (`create_users`, `add_email_to_users`, …) carries over.
- SQLite alterations that SQLite cannot do in place (changing a column's type, most constraint changes) rebuild the table,
  with foreign key checks switched off before the transaction starts, as SQLite's documented procedure requires. So
  each migration on SQLite runs with them off, and fails if it leaves new broken references when it ends. Nothing
  cascades while it runs, which it reports the same way.

### Existing Knex migration and seed files

They cannot run without Knex, so `tenora upgrade` **converts them to Tenora's format**, and keeps a converted file only
once it has proved that the converted files build the same schema as the originals.

Conversion stays mechanical because converted files use a **Knex-compatible blueprint**: `migration({ compat: "knex", … })`
gives the schema callbacks Knex's method names with Knex's semantics, generated by the same schema engine as everything
else. `increments` is `serial` on Postgres and `int unsigned auto_increment` on MySQL, `string` defaults to 255,
`timestamps()` without arguments is two `datetime` columns, and indexes and constraints are named as Knex names them
(`users_email_unique`, `users_team_id_foreign`). New migrations use the default, Laravel-style blueprint, where `id()`
is a `bigint` and `timestamps()` follows Laravel. A converted file keeps its calls almost unchanged, so the diff is easy
to review:

```js
// before: migrations/tenants/20250101120000_create_orders.js (Knex)
exports.up = (knex) =>
  knex.schema.createTable("orders", (t) => {
    t.increments("id").primary();
    t.integer("customer_id").unsigned().notNullable().references("id").inTable("customers").onDelete("CASCADE");
    t.decimal("total", 12, 2).notNullable().defaultTo(0);
    t.timestamps(true, true);
  });
exports.down = (knex) => knex.schema.dropTableIfExists("orders");

// after: the same file, converted by tenora upgrade
const { migration } = require("@tenora/orm");

module.exports = migration({
  compat: "knex",
  up: ({ schema }) =>
    schema.createTable("orders", (t) => {
      t.increments("id").primary();
      t.integer("customer_id").unsigned().notNullable().references("id").inTable("customers").onDelete("CASCADE");
      t.decimal("total", 12, 2).notNullable().defaultTo(0);
      t.timestamps(true, true);
    }),
  down: ({ schema }) => schema.dropTableIfExists("orders"),
});
```

What the converter handles:

- Every export style (`exports.up`, `export const up`, `export async function up`, `module.exports = { up, down }`), in
  JavaScript and TypeScript, keeping the file's module format, name and comments.
- `knex.schema.*` (`createTable`, `alterTable`/`table`, `dropTable(IfExists)`, `renameTable`, `hasTable`, `hasColumn`,
  `raw`) and the column and index builder chains.
- Data changes inside migrations: `knex.raw(sql, bindings)` → `db.raw(…)`, `knex("users")…` → `db.table("users")…` for
  the builder methods both have (`where*`, `insert`, `update`, `del`, `select`, `first`, `pluck`, `orderBy`, …), and
  `knex.fn.now()` → `db.fn.now()`.
- Seed files (`exports.seed = async (knex) => …`), the same way.

What it leaves alone, with the file, line and reason in the report: code that branches on the dialect
(`knex.client.config.client`), helpers imported from other files, dynamic method names, promise chains it cannot follow,
transactions opened inside a migration, and Knex APIs with no equivalent. Those files stay Knex files (see the end of
this section).

**The proof.** The converter is not trusted on its own, because a silent difference between old and new tenants is the
one outcome that must not happen. Before writing anything, the command builds the schema twice in throwaway databases
on the project's database server, the way `schema:dump:tenants` does: once by running the original files through Knex
(which a 0.x project has installed), once by running the converted files through Tenora. It compares the two through the
database catalog (tables, column types, nullability, defaults, primary keys, indexes, unique and foreign keys, checks)
after every migration has run, and again after every rollback step, so the `down` functions are checked too. Seeds run
on both sides and the data is compared. At the first difference it stops, names the migration and prints the
difference; files are replaced only when both sides match. Comparing through catalog queries rather than dump tools
means it works on all five databases, SQL Server included, and needs no `pg_dump` or `mysqldump`.

The history does not change. A converted file keeps its name, so `tenora_migrations` already lists it and existing
databases do not run it again. (`tenora_migrations` stores names without the extension, so a later rename from `.js` to
`.ts` does not look like a new migration.)

**Baselining** is still worth doing for a project with many migrations, because a new tenant then loads one dump instead
of running every file. It is also the way out for files the converter left alone, except on SQL Server, which has no
dumps:

1. Still on 0.x, run every migration everywhere (`tenora migrate`, `tenora migrate:tenants`).
2. Still on 0.x, write schema dumps and prune: `tenora schema:dump:tenants --prune` and the new
   `tenora schema:dump:base --prune` (added to 0.x in a minor release, so projects can prepare before upgrading).
   The dump is the baseline: new databases load it, existing ones already have it.
3. Upgrade to 1.0 and run `tenora upgrade` (below), which records the pruned migrations as run on every database.

Rolling back into the pruned history is not possible, exactly as with `--prune` today.

Pruning the base needs one change in 0.x first. `ensureRegistryMigration` (`core/src/tenantRegistry.ts`) decides
whether to generate the registry migration by looking for the `tenora:registry` marker in the migration files. Once the
base is pruned, that file is gone, so the next `tenora migrate` would generate it again and fail on the existing
`tenora_tenants` table. Before `schema:dump:base --prune` ships, the check also has to accept the registry migration
being in the dump or in the database's history. The 1.0 migrator makes the same check against `tenora_migrations`.

**What is left** after converting and baselining (unusual code on SQL Server, or files a team prefers to rewrite by hand
later) still runs. The 1.0 migrator recognises a file that exports `up(knex)` and, **if the user installs `knex`
themselves**, calls it directly (not through Knex's migrator) with a Knex instance on the same database, in a Knex
transaction of its own, then records it in `tenora_migrations`. Seed files the converter left alone run the same way.
`knex` is an optional peer dependency used for nothing else, and this legacy runner is removed in 2.0.

## The upgrade command

"Migrating existing connections" covers four things, and `tenora upgrade` handles all of them:

| What | `tenora upgrade` |
| --- | --- |
| **Databases**: base and every tenant have Knex bookkeeping (`knex_migrations`, `knex_migrations_lock`) | copies it into `tenora_migrations` |
| **Migration and seed files**: Knex code | converts them after proving they build the same schema; leaves the rest as legacy files |
| **Config**: `tenora.config.js` has Knex-shaped options (`knexOptions`, Knex pool and connection types, `client: "sqlite3"`) | 1.0 still reads the 0.x shape, with deprecation warnings; `--write-config` rewrites it |
| **Application code**: Objection models, `Model.query(req.knex)`, `req.knex`, `trx` arguments | converts the common patterns; marks and lists the rest |

The code converters live in a separate package, `@tenora/upgrade`, so the runtime and the CLI do not carry a JavaScript
parser. `tenora upgrade` loads it, and asks for it to be added as a dev dependency when it is missing.

Steps, each idempotent, with `--dry-run` printing what would change. `--only databases|migrations|code` runs one part.
The steps that change files need a clean git working tree and write only with `--write`, so the result is a diff to
review:

1. **Preflight** (read-only; also shipped to 0.x as `tenora upgrade --check`): load the config; connect to the base;
   list the registry; connect to every tenant (which also checks that the passwords decrypt); check that no database
   has pending migrations, that no Knex migration lock is held, and that every migration file on disk appears in the
   dump or in each database's history. It stops with a list of problems.
2. **Bookkeeping**, per database (base, then tenants, `--concurrency <n>`), in one transaction each: create
   `tenora_migrations` and `tenora_migrations_lock`; copy every `knex_migrations` row in `id` order (`name`, `batch`,
   `migration_time` → `migrated_at`, `source = 'knex'`). It honours a custom Knex `tableName`/`schemaName` from
   `knexOptions.migrations`, and refuses a database whose `knex_migrations_lock.is_locked` is 1. Rows already present
   are skipped, so an interrupted run can simply be repeated. From then on only `tenora_migrations` is used. The Knex
   tables are left untouched, not used, so 0.x still works against the same databases if the user downgrades.
3. **Schema dumps**: rewrites each dump so it creates and fills `tenora_migrations` instead of `knex_migrations`
   (the schema SQL itself is unchanged).
4. **Migration and seed files**: convert, prove, write (see
   [Existing Knex migration and seed files](#existing-knex-migration-and-seed-files)).
5. **Models and code**: convert Objection models and their call sites (see
   [Converting Objection models](#converting-objection-models)); for TypeScript projects, type-check the result.
6. **Report**: everything left: legacy migration and seed files, `TODO(tenora-upgrade)` markers, type errors, Objection
   validation (`jsonSchema`) that no longer runs, `getTenant(...)` used as a Knex instance, Knex-only config keys. Each
   with file, line and what to change.
7. **Cleanup**, later and separately: `tenora upgrade --drop-legacy-tables` drops `knex_migrations*` everywhere once the
   user no longer needs a downgrade.

The registry table, its columns and the encrypted password format do not change, so nothing else in the databases needs
converting.

### Converting Objection models

`tenora upgrade` converts model classes and the code that queries them, under the same rules as the migration converter:
`--dry-run` shows the diff, files change only with `--write`, and everything it does not convert gets a
`// TODO(tenora-upgrade): …` comment and a report entry.

| Objection | Tenora |
| --- | --- |
| `class Person extends Model` from `objection` | `extends Model` from `@tenora/orm`, with `static connection = "tenant"`, or `"base"` for a model the codemod sees queried through `getBase()` |
| `static tableName`, `static idColumn` | `static table`, `static primaryKey` |
| `relationMappings` with `HasManyRelation`, `HasOneRelation`, `BelongsToOneRelation`, `ManyToManyRelation` (`through`), `HasOneThroughRelation` | relation methods, with the keys read from `join.from` and `join.to` |
| `jsonSchema` | `casts` for the types it implies (`boolean`, `integer`, `object`/`array` → `json`); the validation itself is reported, because Tenora does not validate |
| `modifiers` | scopes |
| `$beforeInsert`, `$beforeUpdate`, `$afterInsert`, `$afterFind`, … | `creating`, `updating`, `created`, `retrieved`, … events |
| `virtualAttributes` | `appends` |
| `Person.query(req.knex)`, `Person.query(trx)` | `Person.query()`: the tenant comes from the context, the transaction from `transaction()` |
| `Person.transaction(knex, async (trx) => …)`, `transaction(Person, Animal, …)` | `transaction(async () => …)`, with the `trx` arguments inside removed |
| `.findById(id)`, `.insert(obj)`, `.patch(obj)`, `.deleteById(id)` | `find(id)`, `create(obj)`, `update(obj)`, `destroy(id)` |
| `.withGraphFetched("[pets, children.pets]")` | `.with("pets", "children.pets")` |
| `person.$relatedQuery("pets")` | `person.pets()` |
| `insertGraph`, `upsertGraph`, `$formatJson`, `$parseDatabaseJson`, custom query builder classes | not converted; marked and reported |

Model definitions convert almost completely for these patterns. Call sites are harder, because a codemod sees syntax,
not types: it converts what it can identify as an Objection call and marks the rest. For TypeScript projects the
command ends with a type-check of the converted project and lists the errors with the TODOs; the project's own tests are
the final check. There is no schema-style proof for application code, and the plan does not pretend there is.

### Incremental adoption

Not every model converts in one go. 1.0 ships `@tenora/multi-tenant/knex`, a subpath that needs `knex` installed by the
user and returns a Knex instance for a tenant from the same config (`tenora.tenant(id).knex()`), so the Objection models
that are left and the converted Tenora models run side by side while the rest moves over. They use different connections,
so one transaction does not cover both; the docs say so. This bridge is removed in 2.0, along with the legacy migration
runner.

## Keeping 0.x maintained

1.0 is a very large change, so it is released as a **canary** beside 0.x for as long as it needs, not in place of it.
Anyone can install it on purpose, and nobody gets it by accident: 0.x stays what `npm install` gives, and keeps getting
releases.

| | 0.x | 1.0 canary |
| --- | --- | --- |
| Branch | `development`, released through `main` | `next` |
| npm dist-tag | `latest` | `canary` |
| Versions | 0.4.1, 0.5.0, … | 1.0.0-canary.N |
| Install | `npm install @tenora/multi-tenant` | `npm install @tenora/multi-tenant@canary` |

1. `development` stays the 0.x line, and its releases are made from it as today. It keeps Node 22.12.
2. `next` holds the 1.0 work. It requires Node `>=24.15.0` and tests on Node 24 and 26. It stays in Changesets pre mode
   with the tag `canary`. A push with a new changeset opens or updates a "Version Packages (canary)" PR, and merging that
   PR publishes, so the next canary needs a changeset describing it. The release script also passes `--tag canary`, so
   nothing on `next` can move `latest`, even if pre mode is ever left by mistake.
3. `development` is merged into `next` regularly, so 0.x changes reach 1.0 as they land. A 0.x release's version bumps
   conflict in `package.json` and the changelogs: keep `next`'s versions, and take the changelog entries from both sides.
   `baseBranch`, the release script and the workflow's branch list differ on purpose, so if they conflict, keep `next`'s.
4. `@tenora/orm` has no 0.x version and nothing in 0.x depends on it, so its dist-tags affect no existing user. Check them
   with `npm view @tenora/orm dist-tags` after the first publish, and install it as `@tenora/orm@canary` either way.
5. Promoting 1.0.0 is a separate decision, taken once the canary has proved itself on real projects. Then cut
   **`release/0.x`** from `main` at the last 0.x release; on that branch set Changesets' `baseBranch` to `release/0.x`, add
   the branch to the release workflow, and publish with `changeset publish --tag v0`, because without the tag a 0.x patch
   published after 1.0 would become `latest`. On `next`, run `changeset pre exit`, drop `--tag canary`, set `baseBranch`
   back to `main`, and merge `next` into `development`, which becomes the 1.0 line.
6. A 0.x minor adds what helps people prepare, made on `development`: `schema:dump:base`, the registry check that survives
   pruning, and `tenora upgrade --check`.
7. Support window: bug fixes on 0.x for 6 months after 1.0.0, security fixes for 12 months. Once `development` no longer
   has the Knex code, most 0.x fixes touch code that exists only on `release/0.x`, so fixes are made there, in PRs
   against `release/0.x`, and carried forward to `development` by hand when the same problem exists in 1.0. At end of
   life, `npm deprecate` marks the 0.x range with a pointer to the upgrade guide.

## Phases

Each phase ends with something releasable as a canary and tested on all five databases with the existing harness
(`tests/run.mjs`, `npm run test:docker`), extended with an ORM suite.

| Phase | Deliverable | Done when |
| --- | --- | --- |
| 0. Prepare 0.x | on `development`: 0.4.0 released, then a 0.x minor with `schema:dump:base`, the registry check that survives pruning, and `upgrade --check`; `release/0.x` cut when 1.0 prereleases start | users can baseline on 0.x |
| 1. Engine (done on `next`) | `@tenora/orm`: driver adapters, pools, connections and transactions (savepoints, queueing, verified commits, after-commit, retries), the `compile()` module with snapshot tests, query builder and dialect rules, `sql` fragments | `db.table()` CRUD, joins, aggregates, upserts and every transaction rule pass on all five databases |
| 2. Schema and migrator; core on the engine (done on `next`) | blueprint schema builder with the SQLite rebuild, migrator on `tenora_migrations`, seeder, schema dumps; provisioning, registry and every CLI command ported; Knex removed from `core` and `cli` | the existing CLI and lifecycle tests pass with Knex not installed |
| 3. Models (model core done on `next`; relations, eager loading and pagination of relations still to do) | attributes, casts, fillable, timestamps, dirty tracking, CRUD, events and observers, scopes, soft deletes, serialization, strict mode; hasOne, hasMany, belongsTo, belongsToMany, hasManyThrough; eager loading, `withCount`, `whereHas`; pagination and chunking; type design measured and frozen | model test suite passes on all five databases |
| 4. Tenancy | tenant context, connection resolver, `createTenora`, middleware, `tenant(id).run()`, idle pool eviction, cross-connection write warnings, `@tenora/multi-tenant/knex` bridge | a sample app with base and tenant models runs without passing connections around |
| 5. Upgrade: databases | `tenora upgrade` preflight, bookkeeping, dumps, `--write-config`, `--drop-legacy-tables`; the legacy Knex file runner; schema introspection through the catalog on all five databases | a 0.4 fixture project with tenants on every database upgrades, and still works on 0.x afterwards |
| 6. Upgrade: code | `@tenora/upgrade`: the Knex-compatible blueprint, migration and seed converter with the schema proof, Objection model and call-site converter, report, upgrade guide | the fixture project's migrations and seeds convert and prove equal on all five databases; its models convert and its tests pass |
| 7. Release | docs, dogfooding on real apps through the canary, then promoting 1.0.0 to `latest` | — |
| Later (1.x) | polymorphic relations, model factories and test helpers (a rolled-back transaction per test), tenant-aware queued jobs, streaming `cursor()`, read replicas, query logging hooks, typed models generated from the schema | — |

Phases 1 and 2 are most of the work. Phase 3 can start as soon as phase 1's builder is stable, in parallel with phase 2,
and phase 6 can start once phase 2's schema builder exists. SQL Server is part of every phase from the first, not a
follow-up.

## Risks

- **Size.** Even with Kysely compiling the SQL, the dialect rules, connection layer, schema builder and migrator are
  several thousand lines before any model code, and the upgrade converters add their own. Mitigations: a strict 1.0
  scope and the existing real-database harness. SQL Server ships in 1.0, so its driver (one request per connection,
  typed parameters, named transactions) and dialect rules are on the critical path from phase 1.
- **Kysely changes.** It is 0.x, kept by two maintainers, and has broken things in minor and patch releases. Mitigations:
  one internal module, an exact pin, snapshot tests per dialect, and the option to replace it with our own compiler.
- **`AsyncLocalStorage` surprises**: context lost in some callback-based libraries, or carried into fire-and-forget work
  that outlives a transaction. Mitigations: everything also works with explicit `on()`/`using()`; work that runs after a
  transaction ended gets `TransactionClosedError`, not a write outside it. Overhead is small (about 10% of raw HTTP
  throughput on Node 22 and 7% on Node 24 in Platformatic's benchmark), and one context object is used, not several.
- **Different DDL between old and new tenants.** Converted migrations use the Knex-compatible blueprint, and are only
  written once the schema proof shows both sides match. New migrations in the default blueprint follow Laravel's
  conventions, which is intended.
- **Codemod coverage.** Objection call sites vary more than model definitions, and a codemod sees syntax, not types.
  Mitigations: mark and report rather than guess, type-check the result, and keep the Knex bridge until 2.0 for what is
  left.
- **Two release lines** double the CI and backport work for the support window.
- **Type complexity**: inferring column and relation names must not make TypeScript 7 slow on large model sets; the type
  design is prototyped and measured before it is frozen.

## Decisions

Settled on 2026-11-07:

1. **`tenora upgrade` converts application code in 1.0**: Objection models and their call sites, as well as the
   databases and the config ([Converting Objection models](#converting-objection-models)).
2. **Engine**: the hybrid. Kysely compiles for all five databases, which was checked for the syntax that only some of
   them have; Tenora writes its own compiler only for a construct a dialect needs that neither Kysely nor a `sql`
   template can produce ([The engine](#the-engine)).
3. **Layering**: the ORM is the engine underneath core and the tenancy packages; users get it through
   `@tenora/multi-tenant` ([Packages](#packages)).
4. **Knex migration and seed files are converted to Tenora's format**, with the schema proof. Optional Knex stays until
   2.0, only for files the converter cannot handle and for the side-by-side bridge
   ([Existing Knex migration and seed files](#existing-knex-migration-and-seed-files)).
5. **SQL Server ships in 1.0.**
6. **Node 24.15 or newer** for 1.0, required on `next` from the start; `development` keeps Node 22.12 while it ships
   0.x ([Keeping 0.x maintained](#keeping-0x-maintained)).
7. **0.x support**: bug fixes for 6 months and security fixes for 12 months after 1.0.0.
8. **All packages release as 1.0.0.**

Settled on 2026-11-08:

9. **1.0 ships as a canary first**, `1.0.0-canary.N` under the `canary` dist-tag from `next`, while 0.x stays `latest` and
   keeps getting releases ([Keeping 0.x maintained](#keeping-0x-maintained)).
