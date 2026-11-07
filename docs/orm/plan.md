# Tenora ORM: plan for 1.0

Status: proposal, nothing built yet. The research behind it, with sources, is in [research.md](research.md).

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

The 0.x line keeps getting fixes for a defined window, and a `tenora upgrade` command moves existing databases (the
base and every tenant) from Knex's migration bookkeeping to Tenora's own `tenora_migrations` table.

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
5. Every database 0.x supports: Postgres, MySQL, MariaDB, SQLite, SQL Server.
6. A tested, reversible upgrade from 0.x, and a maintained 0.x line while people move.

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
```

This puts the ORM *underneath* the tenancy packages, not on top of `@tenora/multi-tenant`, because core needs the same
engine to provision tenants and run migrations, and an ORM on top would make that a circular dependency. Users still see
it the other way round: they install `@tenora/multi-tenant` and get the ORM with tenancy built in.

`@tenora/orm` does not depend on the tenancy packages. Like Eloquent asking Laravel's `DatabaseManager` for a connection
by name, a model asks a **connection resolver** for `"base"` or `"tenant"`, and `@tenora/multi-tenant` registers the
resolver that knows the current tenant. This keeps the dependency direction one way (`orm ← core ← multi-tenant, cli`),
lets core use the same engine for provisioning and migrations, and keeps the ORM testable on its own.

Users install `@tenora/multi-tenant` (which brings the ORM) and their driver. `@tenora/orm` joins the Changesets `fixed`
group, so all four packages release together as 1.0.0.

## The engine

**Recommendation: a hybrid.** Tenora owns everything users see and everything that decides correctness: the query
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

Checked before recommending it: Kysely 0.29.8 type-checks under the repo's TypeScript 7.0.2 with `skipLibCheck` off, and
compiles queries and DDL for Postgres, MySQL, SQL Server and SQLite with no database.

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
| Schema builder | Tenora | Laravel-style blueprint (`t.id()`, `t.string()`, `t.foreignId().constrained()`, `t.timestamps()`), compiled through the same module |
| Migrator and seeder | Tenora | `tenora_migrations`, batches, locks, `.ts`/`.js`/`.sql` migrations, schema dumps |
| ORM | Tenora | models, attributes, casts, relations, eager loading, scopes, events, soft deletes, serialization, pagination |

Driver decisions:

- **`sqlite3` is dropped.** It is deprecated and its repository archived. SQLite projects switch to `better-sqlite3`
  (same database files, nothing to convert), and `tenora upgrade` reports a `client: "sqlite3"` config.
- **`node:sqlite`** (built into Node) is supported from Node 24.15, where it is a release candidate without a warning.
- Dates and booleans are encoded by Tenora for SQLite: `better-sqlite3` throws on them, and `node:sqlite` silently
  stores a `Date` as `NULL`.
- **`mariadb`**: big integers and ids come back as `BigInt`, decimals as strings; the adapter normalizes them, and resets
  session state when a connection goes back to the pool, since the driver no longer does.
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
  with foreign key checks switched off before the transaction starts, as SQLite's documented procedure requires.

### Existing Knex migration and seed files

They cannot run without Knex. The plan is to **baseline them, not to translate them**:

1. Still on 0.x, run every migration everywhere (`tenora migrate`, `tenora migrate:tenants`).
2. Still on 0.x, write schema dumps and prune: `tenora schema:dump:tenants --prune` and the new
   `tenora schema:dump:base --prune` (added to 0.x in a minor release, so projects can prepare before upgrading).
   The dump is the baseline: new databases load it, existing ones already have it.
3. Upgrade to 1.0 and run `tenora upgrade` (below), which records the pruned migrations as run on every database.

After that, the project's history starts at the dump, and new migrations use the new format. What this costs: rolling
back into the pruned history is not possible, exactly as with `--prune` today.

Pruning the base needs one change in 0.x first. `ensureRegistryMigration` (`core/src/tenantRegistry.ts`) decides
whether to generate the registry migration by looking for the `tenora:registry` marker in the migration files. Once the
base is pruned, that file is gone, so the next `tenora migrate` would generate it again and fail on the existing
`tenora_tenants` table. Before `schema:dump:base --prune` ships, the check also has to accept the registry migration
being in the dump or in the database's history. The 1.0 migrator makes the same check against `tenora_migrations`.

Where a dump is not possible, mainly **SQL Server** (it has no schema dumps), or for a project that wants to keep its old
files runnable for a while, 1.0 can run legacy Knex migration files **if the user installs `knex` themselves**: the
migrator recognises a file that exports `up(knex)` and calls it directly (not through Knex's migrator) with a Knex
instance on the same database, in a Knex transaction of its own, then records it in `tenora_migrations`. `knex` becomes an optional peer dependency used for nothing else, and the legacy
runner is removed in 2.0. Translating Knex schema code into the blueprint format with a codemod is rejected: two schema
builders produce different DDL for the same call (`increments` vs `id`, default lengths, index names), and a silent
difference between old and new tenants is worse than a visible baseline.

Seeds are not history, so they are not baselined: existing Knex seed files run through the same optional legacy runner
until the user rewrites them, and `tenora upgrade` lists them.

## The upgrade command

"Migrating existing connections" covers three things. `tenora upgrade` does the first two and reports on the third:

| What | `tenora upgrade` |
| --- | --- |
| **Databases**: base and every tenant have Knex bookkeeping (`knex_migrations`, `knex_migrations_lock`) | copies it into `tenora_migrations` |
| **Config**: `tenora.config.js` has Knex-shaped options (`knexOptions`, Knex pool and connection types, `client: "sqlite3"`) | 1.0 still reads the 0.x shape, with deprecation warnings; `--write-config` rewrites it |
| **Application code**: Objection models, `Model.query(req.knex)`, `req.knex` | does not rewrite it; prints every place with file and line |

Steps, each idempotent, with `--dry-run` printing what would change:

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
4. **Report**: legacy migration and seed files still on disk, Objection imports, `Model.query(…knex…)`, `req.knex`,
   `getTenant(...)` used as a Knex instance, Knex-only config keys. Each with file, line and what to change.
5. **Cleanup**, later and separately: `tenora upgrade --drop-legacy-tables` drops `knex_migrations*` everywhere once the
   user no longer needs a downgrade.

The registry table, its columns and the encrypted password format do not change, so nothing else in the databases needs
converting.

### Incremental adoption

A large application cannot rewrite every Objection model in one release. 1.0 ships `@tenora/multi-tenant/knex`, a
subpath that needs `knex` installed by the user and returns a Knex instance for a tenant from the same config
(`tenora.tenant(id).knex()`), so old Objection models and new Tenora models can run side by side while code moves over.
They use different connections, so one transaction does not cover both; the docs say so. This bridge is removed in 2.0
along with the legacy migration runner. A best-effort Objection → Tenora model codemod (`tableName`, `idColumn`,
`relationMappings`, `jsonSchema` → casts, `$beforeInsert` → events, `modifiers` → scopes) is a 1.x item.

## Keeping 0.x maintained

1. Release what is on `development` as **0.4.0** first (the crypto change and schema dumps). Merge PR #12 (trusted
   publishing) before that release.
2. Cut **`release/0.x`** from `main` at the 0.4.0 tag. On that branch, set Changesets' `baseBranch` to `release/0.x`,
   and add the branch to the release workflow, publishing with `changeset publish --tag v0`. Without the tag, a 0.x
   patch published after 1.0 would become `latest`.
3. `development` becomes the 1.0 line. 1.0 prereleases use Changesets pre mode (`changeset pre enter next`) and publish
   `1.0.0-next.N` under the `next` dist-tag.
4. A 0.5.0 minor adds what helps people prepare: `schema:dump:base`, `tenora upgrade --check`.
5. Proposed support window: bug fixes on 0.x for 6 months after 1.0.0, security fixes for 12 months. Once `development`
   no longer has the Knex code, most 0.x fixes touch code that exists only on `release/0.x`, so fixes are made there,
   in PRs against `release/0.x`, and carried forward to `development` by hand when the same problem exists in 1.0. The
   README gets a "Which version" table; at end of life, `npm deprecate` marks the 0.x range with a pointer to the
   upgrade guide.
6. CI runs the full database suite on both branches.

## Phases

Each phase ends with something releasable as a prerelease and tested on all five databases with the existing harness
(`tests/run.mjs`, `npm run test:docker`), extended with an ORM suite.

| Phase | Deliverable | Done when |
| --- | --- | --- |
| 0. Prepare 0.x | 0.4.0 released, `release/0.x` cut, 0.5.0 with `schema:dump:base`, the registry check that survives pruning, and `upgrade --check` | users can baseline on 0.x |
| 1. Engine | `@tenora/orm`: driver adapters, pools, connections and transactions (savepoints, queueing, verified commits, after-commit, retries), the `compile()` module with snapshot tests, query builder and dialect rules, `sql` fragments | `db.table()` CRUD, joins, aggregates, upserts and every transaction rule pass on all five databases |
| 2. Schema and migrator; core on the engine | blueprint schema builder with the SQLite rebuild, migrator on `tenora_migrations`, seeder, schema dumps; provisioning, registry and every CLI command ported; Knex removed from `core` and `cli` | the existing CLI and lifecycle tests pass with Knex not installed |
| 3. Models | attributes, casts, fillable, timestamps, dirty tracking, CRUD, events and observers, scopes, soft deletes, serialization, strict mode; hasOne, hasMany, belongsTo, belongsToMany, hasManyThrough; eager loading, `withCount`, `whereHas`; pagination and chunking; type design measured and frozen | model test suite passes on all five databases |
| 4. Tenancy | tenant context, connection resolver, `createTenora`, middleware, `tenant(id).run()`, idle pool eviction, cross-connection write warnings, `@tenora/multi-tenant/knex` bridge, legacy Knex file runner | a sample app with base and tenant models runs without passing connections around |
| 5. Upgrade | `tenora upgrade` (preflight, bookkeeping, dumps, report, `--write-config`, `--drop-legacy-tables`), upgrade guide | a 0.4 fixture project with tenants on every database upgrades, and still works on 0.x afterwards |
| 6. Release | `1.0.0-next.N` prereleases, docs, dogfooding on a real app, then 1.0.0 | — |
| Later (1.x) | polymorphic relations, model factories and test helpers (a rolled-back transaction per test), Objection model codemod, tenant-aware queued jobs, streaming `cursor()`, read replicas, query logging hooks, typed models generated from the schema dump | — |

Phases 1 and 2 are most of the work. Phase 3 can start as soon as phase 1's builder is stable, in parallel with phase 2.

## Risks

- **Size.** Even with Kysely compiling the SQL, the dialect rules, connection layer, schema builder and migrator are
  several thousand lines before any model code. Mitigations: a strict 1.0 scope and the existing real-database harness.
  If SQL Server is what holds 1.0 back, it ships in 1.1 while SQL Server users stay on 0.x.
- **Kysely changes.** It is 0.x, kept by two maintainers, and has broken things in minor and patch releases. Mitigations:
  one internal module, an exact pin, snapshot tests per dialect, and the option to replace it with our own compiler.
- **`AsyncLocalStorage` surprises**: context lost in some callback-based libraries, or carried into fire-and-forget work
  that outlives a transaction. Mitigations: everything also works with explicit `on()`/`using()`; work that runs after a
  transaction ended gets `TransactionClosedError`, not a write outside it. Overhead is small (about 10% of raw HTTP
  throughput on Node 22 and 7% on Node 24 in Platformatic's benchmark), and one context object is used, not several.
- **Different DDL from the new schema builder** than Knex produced for the same intent. Affects only new migrations;
  existing tables are untouched by the baseline approach.
- **Two release lines** double the CI and backport work for the support window.
- **Type complexity**: inferring column and relation names must not make TypeScript 7 slow on large model sets; the type
  design is prototyped and measured before it is frozen.

## Decisions needed

1. **What "migrate the existing connections" should cover.** Proposed: databases and config, plus a report on
   application code (above). Should `tenora upgrade` also rewrite Objection models in 1.0, rather than in 1.x?
2. **The engine**: the hybrid (recommended), or our own SQL compiler as well (about 10–14k more lines, no dependency).
3. **Layering**: the ORM as the engine underneath core and the tenancy packages (recommended, see [Packages](#packages)),
   or literally on top of `@tenora/multi-tenant`, with core keeping a separate low-level database layer.
4. **Optional Knex for legacy migrations and the side-by-side bridge** until 2.0, or none at all (then baselining is
   required, and SQL Server users rewrite their migrations).
5. **SQL Server in 1.0**, or in 1.1.
6. **Node version for 1.0**: proposed Node 24.15 or newer. Node 22 reaches end of life on 2027-04-30, around when 1.0
   would ship, and 24.15 is where `node:sqlite` stops being experimental.
7. **0.x support window**: 6 months of fixes and 12 of security fixes, or longer.
8. **Version**: 1.0.0 for all packages (recommended), rather than another 0.x minor.
