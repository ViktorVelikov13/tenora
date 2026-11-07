# Tenora ORM: research

Research for [plan.md](plan.md), done on 2026-11-07. Versions and dates come from the npm registry and GitHub; where a
finding comes from reading source code, the file is named. Sources are listed per section.

## Contents

1. [Objection and Knex today](#1-objection-and-knex-today)
2. [Eloquent: what to borrow](#2-eloquent-what-to-borrow)
3. [Laravel multi-tenancy packages](#3-laravel-multi-tenancy-packages)
4. [Transactions in other Node ORMs](#4-transactions-in-other-node-orms)
5. [AsyncLocalStorage](#5-asynclocalstorage)
6. [Build or wrap](#6-build-or-wrap)
7. [Drivers](#7-drivers)

## 1. Objection and Knex today

### Status

| Package | Latest | Notes |
| --- | --- | --- |
| `objection` | 4.4.3 (2026-11-05); `legacy` tag 3.9.3 | Now published from the **ditojs/objection** fork by its sole maintainer (Jürg Lehni), who writes that Vincit removed his access in 2026. 3.1.5 (2024-09) was followed by nothing until 3.2.0 (2026-10-09); 3.2 to 4.4.3 shipped in about four weeks. 4.0 is ESM-only, needs knex ^3.3.0 as a peer, MySQL 8, and has stricter typings. |
| `knex` | 3.3.0 (2026-06-26) | Gap from 3.1.0 (2023-12) to 3.2.0 (2026-03), then a burst of releases; nothing since June. 776 open issues. Typings are hand-written and "best-effort". 3.3.0 added a MariaDB driver. |

Objection's original author has said its design predates TypeScript and that he would stop working on it
([#2335](https://github.com/Vincit/objection.js/issues/2335)); he built Kysely instead, and in
[#2174](https://github.com/Vincit/objection.js/issues/2174) explains that relations and inheritable query builders make
full type safety very hard in Objection. A Knex maintainer suggested Kysely in
[#2807](https://github.com/Vincit/objection.js/issues/2807). Both projects are moving again, but on few maintainers.

### Why Objection transactions go wrong with several tables

Every style Objection supports ([guide](https://ditojs.github.io/objection/guide/transactions.html)):

```js
await Person.transaction(async (trx) => {
  const p = await Person.query(trx).insert({ firstName: "J" });
  await p.$relatedQuery("pets", trx).insert({ name: "Scrappy" });
});
const trx = await Person.startTransaction();
await transaction(Person, Animal, async (Person, Animal, trx) => { /* bound copies */ });
const BoundPerson = Person.bindKnex(trx);
```

Checked against the 4.4.3 source (`lib/model/Model.js`, `lib/model/modelBindKnex.js`, `lib/transaction.js`):

- **Every query opts in, and forgetting gives no error.** `Model.query(trx)` with `trx` undefined falls back to
  `Model.knex()` and autocommits.
- **A fetched instance does not remember its transaction.** After `const p = await Person.query(trx).findById(1)`,
  `p.$relatedQuery("pets").insert(x)` runs outside the transaction. This is the main footgun; Lucid fixes it by pinning
  the transaction on the instance.
- **Bound classes are new classes.** `bindKnex` creates and caches a subclass per transaction, so `BoundPerson !== Person`;
  any helper importing `Person` directly runs outside the transaction, and `instanceof` checks break.
- **The bound-model form picks the database from the first model's knex**, so with a per-request tenant knex and nothing
  bound globally it cannot be used ([#1524](https://github.com/Vincit/objection.js/issues/1524)).
- **Pool exhaustion**: a forgotten `trx` needs a second pooled connection, and with small per-tenant pools that fails as
  Knex's `Timeout acquiring a connection … Are you missing a .transacting(trx) call?`.
- **Graph writes** were not atomic without a `trx` ("There will never be implicit transactions in objection",
  [#809](https://github.com/Vincit/objection.js/issues/809)); 4.3.0 reversed this for strict mode only.
- **An AsyncLocalStorage recipe** was proposed and rejected ([#1825](https://github.com/Vincit/objection.js/pull/1825)),
  because nothing guarantees `knex()` is the code path and it monkey-patches a prototype. For multi-tenancy the author
  suggested a per-request transaction plus `bindTransaction` ([#1023](https://github.com/Vincit/objection.js/issues/1023)).
- Related threads: forcing transactions from hooks ([#901](https://github.com/Vincit/objection.js/issues/901)), nested
  transactions with `Promise.all` ([#838](https://github.com/Vincit/objection.js/issues/838)), automatic graph
  transactions ([#1939](https://github.com/Vincit/objection.js/issues/1939)).

### How Knex transactions work

From the [guide](https://knexjs.org/guide/transactions.html) and `lib/execution/transaction.js` at 3.3.0:

- One connection per transaction; a query on another connection throws `Invalid connection for transaction query`, and
  queries after the end throw `Transaction query already complete`.
- `trx.transaction()` (alias `trx.savepoint()`) is a `SAVEPOINT`; sibling savepoints now run one at a time.
- **Plain queries on one transaction are not serialized by Knex.** They reach the driver concurrently; `pg` 8 still
  queues them but warns that `pg` 9 will stop.
- **`commit()` can resolve although nothing was committed**: when Postgres answers `COMMIT` with `ROLLBACK` after an
  earlier error, or when `COMMIT` itself fails and the error only reaches `executionPromise`
  ([Lucid #1205](https://github.com/adonisjs/lucid/issues/1205), open, on knex 3.3.0 with pg).

### Knex migration tables

What `tenora upgrade` reads, from `lib/migrations/migrate/table-creator.js` and `Migrator.js` at 3.3.0:

| `knex_migrations` | Type | Notes |
| --- | --- | --- |
| `id` | `increments()` | completed migrations are read `ORDER BY id` |
| `name` | `varchar(255)` | file name with extension, no directory |
| `batch` | `integer` | each run inserts `max(batch) + 1`; rollback deletes the last batch's rows |
| `migration_time` | `timestamp` | `timestamptz` on Postgres |

`knex_migrations_lock` has `index` (`increments()`) and `is_locked` (`integer`, one row). Knex locks with
`UPDATE … SET is_locked = 1 WHERE is_locked = 0` in a transaction. The table name is `tableName` (and `tableName + "_lock"`),
optionally in `schemaName`; all columns are nullable. The importer has to keep `id` order, `batch` and `migration_time`,
honour a custom table name, refuse a held lock, and handle `.js`/`.ts` name differences.

## 2. Eloquent: what to borrow

Read: Laravel **13.x** docs (13.0 released 2026-03-17) and the framework source on the 13.x branch.

### Transactions

Eloquent's transactions feel effortless because of PHP's execution model: `DatabaseManager` caches one `Connection`
object per connection name, holding the PDO handle and a counter. Every model and query on that name runs on that handle,
so it is automatically inside whatever transaction is open. One process serves one request at a time, so this is safe in
PHP and unsafe in Node, where one pool serves many requests at once. The Node equivalent is a connection pinned per
transaction and carried by `AsyncLocalStorage`.

From `Concerns/ManagesTransactions.php`, `DatabaseTransactionsManager.php`, `ConcurrencyErrorDetector.php`:

- `DB::transaction(fn, attempts)` retries **only concurrency errors** (SQLSTATE `40001`, MySQL deadlock and lock wait
  timeout, Postgres deadlock, SQLite "database is locked", SQL Server deadlock victim). Anything else rolls back and
  rethrows. There is no backoff between attempts.
- **Nested transactions never retry.** A deadlock at level > 1 rolls back to the savepoint and throws, because MySQL has
  already rolled back the whole transaction; only the outermost call re-runs the closure.
- Commit-time failures (a Postgres serialization failure at `COMMIT`) are retried too.
- Nesting uses `SAVEPOINT trans2`, `trans3`, …; a nested commit only decrements the counter (no `RELEASE`).
- `DB::afterCommit(cb)` runs when the connection's level reaches 0, drops callbacks of rolled-back levels, and runs
  immediately outside a transaction. **Quirk:** callbacks attach to the most recently begun transaction on *any*
  connection, so with a base and a tenant transaction both open, a tenant callback can be tied to the base commit.
- `ShouldDispatchAfterCommit` events, `ShouldHandleEventsAfterCommit` observers and `afterCommit()` queued jobs are held
  until commit and dropped on rollback.
- `DB::transaction()` always uses the default connection; `DB::connection('tenant')->transaction()` covers only that
  connection. There is no two-phase commit.
- Pitfalls: a lost connection during `COMMIT` leaves the outcome unknown; swapping a connection (`DB::purge`) mid-transaction
  silently destroys it; MySQL DDL commits implicitly and desyncs the counter.
- Worth copying: `createOrFirst` inserts inside a savepoint when a transaction is open, so a unique violation does not
  poison a Postgres transaction.

### Model features

Laravel 13 configures models with PHP attributes (`#[Table]`, `#[Connection]`, `#[Fillable]`, `#[Hidden]`,
`#[ObservedBy]`, `#[ScopedBy]`, `#[Scope]`), merged with the older `$fillable` properties.

| Feature | Fit for TypeScript |
| --- | --- |
| Mass assignment (`fillable`/`guarded`; unknown keys silently dropped) | Clean. Typed `fill()` catches it at compile time; keep a runtime guard for untyped input. |
| Casts, custom `CastsAttributes` | Very clean; a `Cast<Db, App>` type can drive the attribute types. |
| Accessors/mutators (`Attribute::make`) | Partial: needs proxies or generated getters. Prefer plain getters/setters. |
| Timestamps, soft deletes | Clean. Unique indexes and raw SQL still see soft-deleted rows. |
| Global and local scopes | Clean; local scopes need typing work (no magic `scopeX` names). |
| Events and observers (`creating` … `forceDeleted`; `-ing` can halt; `saveQuietly`) | Clean with async, awaited hooks. **Not fired on mass update/delete**, which must be documented. |
| Serialization (`hidden`, `visible`, `appends`) | Clean via `toJSON()`; output type can omit hidden fields. |
| Dirty tracking (`isDirty`, `getOriginal`, `wasChanged`) | Clean; compare cast values, not raw ones. |
| `firstOrCreate`, `updateOrCreate`, `upsert` | Clean; keep the savepoint trick. |
| `chunkById`, `lazyById`, `cursor` | Excellent fit as async iterators; a real cursor holds a connection. |
| Pagination (length-aware, simple, cursor) | Clean; take the page from the caller, not a global request. |
| Factories, `replicate`, `touches` | Clean. |
| `preventLazyLoading`, `preventSilentlyDiscardingAttributes`, `preventAccessingMissingAttributes` (`shouldBeStrict()`) | Port as **on by default**, per instance rather than as static globals. |

### Relations

- hasOne, hasMany, belongsTo (`withDefault`, `latestOfMany`), belongsToMany (pivot named alphabetically, `withPivot`,
  `attach/detach/sync/toggle`), hasOneThrough/hasManyThrough, polymorphic (`morphTo`, `morphMany`, `morphToMany`).
- Polymorphic types store the class name unless a morph map is enforced. In JavaScript the morph map must be required,
  because class names are not stable after minification.
- **Eager loading never joins**: `with('author')` runs a second query `WHERE id IN (…)` per relation and nesting level,
  and matches results in memory. That is why eager loading across the base and a tenant database works.
- `withCount`/`withSum`/`withExists` and `has`/`whereHas` are subqueries. The docs state that relationship existence
  queries do not work across databases.
- `with('posts.comments')` paths can be type-checked with template literal types. Implicit lazy loading (`$user->posts`)
  cannot work in JavaScript without `await`, so it is replaced by an explicit `load()`.

### Criticisms to avoid

- **Active Record coupling**: a model is a row, its persistence, its connection and its side effects at once; `save()`
  silently fires observers.
- **Static magic and global state**: `__callStatic`, facades, and global switches (`preventLazyLoading`, `unguard`,
  `enforceMorphMap`) that do not compose with multi-tenancy or test isolation.
- **N+1 by default**, with opt-in fixes.
- **Weak types**: attributes are read from columns at runtime, so tooling must boot the app or scan the schema.
- **Memory**: every model carries attributes, originals, changes and relations; `cursor()` is still buffered by PDO.
- **God class**: `Model` has 100+ public methods, so column names can collide with method names.

Sources: [database](https://laravel.com/docs/13.x/database), [eloquent](https://laravel.com/docs/13.x/eloquent),
[relationships](https://laravel.com/docs/13.x/eloquent-relationships),
[mutators](https://laravel.com/docs/13.x/eloquent-mutators),
[serialization](https://laravel.com/docs/13.x/eloquent-serialization),
[factories](https://laravel.com/docs/13.x/eloquent-factories), [pagination](https://laravel.com/docs/13.x/pagination),
[events](https://laravel.com/docs/13.x/events), [queues](https://laravel.com/docs/13.x/queues),
[facades](https://laravel.com/docs/13.x/facades); framework source under
[src/Illuminate/Database](https://github.com/laravel/framework/tree/13.x/src/Illuminate/Database).

## 3. Laravel multi-tenancy packages

**spatie/laravel-multitenancy v4** (4.3.1, 2026-11-04):

- A tenant connection and a landlord connection; models pick one with `UsesTenantConnection` /
  `UsesLandlordConnection`, which only override `getConnectionName()`. The default connection is not changed.
- The current tenant is a container binding: `Tenant::current()`, `$tenant->makeCurrent()`, `$tenant->execute(fn)`
  (restores the previous tenant in a `finally`), `Landlord::execute(fn)`.
- Switching purges the tenant connection (`DB::purge('tenant')`) and reconfigures it.
- Queued jobs carry the tenant id; a missing tenant fails the job.

**stancl/tenancy v3** (3.10.1):

- `tenancy()->initialize($tenant)` runs bootstrappers (database, cache, filesystem, queue, Redis), and the database
  bootstrapper switches the **default** connection to the tenant. `$tenant->run(fn)` restores the previous context, but
  without `try/finally`.
- Central models use a `CentralConnection` trait. Cross-database data is synchronised by copying ("resource syncing"),
  not related across databases.

Problems both report, and what they mean for Tenora:

| Reported problem | Lesson |
| --- | --- |
| `DB::transaction()` runs on the landlord connection, so tenant writes are not rolled back ([spatie #371](https://github.com/spatie/laravel-multitenancy/issues/371)) | `transaction()` must default to the tenant, and other connections must be named. |
| Switching tenants purges the connection and kills an open transaction ([#476](https://github.com/spatie/laravel-multitenancy/issues/476), [#442](https://github.com/spatie/laravel-multitenancy/issues/442)) | Key transactions by connection; a different tenant gets a different connection, never a swapped one. |
| Test transactions break with tenant switching ([#377](https://github.com/spatie/laravel-multitenancy/issues/377)) | Test helpers must wrap every connection the test touches. |
| Creating a tenant inside a transaction fails with "There is no active transaction" ([stancl #860](https://github.com/archtechx/tenancy/issues/860), [#772](https://github.com/archtechx/tenancy/issues/772), [#310](https://github.com/archtechx/tenancy/issues/310)) | Provisioning must refuse to run inside a transaction, with a clear error. |
| The process-wide current tenant leaked between requests under Octane ([spatie #597](https://github.com/spatie/laravel-multitenancy/issues/597)) | Carry the tenant in `AsyncLocalStorage`, never in a module-level variable. |

Sources: spatie docs ([multiple databases](https://spatie.be/docs/laravel-multitenancy/v4/installation/using-multiple-databases),
[current tenant](https://spatie.be/docs/laravel-multitenancy/v4/basic-usage/working-with-the-current-tenant),
[queues](https://spatie.be/docs/laravel-multitenancy/v4/basic-usage/making-queues-tenant-aware),
[executing code](https://spatie.be/docs/laravel-multitenancy/v4/advanced-usage/executing-code-for-tenants-and-landlords));
stancl docs ([bootstrappers](https://tenancyforlaravel.com/docs/v3/tenancy-bootstrappers),
[multi-database](https://tenancyforlaravel.com/docs/v3/multi-database-tenancy),
[console commands](https://tenancyforlaravel.com/docs/v3/console-commands),
[synced resources](https://tenancyforlaravel.com/docs/v3/synced-resources-between-tenants)).

## 4. Transactions in other Node ORMs

| ORM | Version | How queries join a transaction | Nesting | After-commit |
| --- | --- | --- | --- | --- |
| AdonisJS Lucid | 22.4.2 | explicit `{ client: trx }`; an instance loaded with a trx keeps it (`$trx`), so `save()` and `related().create()` follow | savepoints | `trx.after('commit')` |
| Sutando (Eloquent port on Knex) | 1.7.4 | explicit `.transacting(trx)` or `{ client: trx }` | not documented | — |
| Sequelize v7 | 7.0.0-alpha.48 | **AsyncLocalStorage by default** | `TransactionNestMode`: `reuse` (default), `savepoint`, `separate` | `afterCommit` |
| MikroORM | 7.2.8 | **AsyncLocalStorage** request context (`RequestContext`); using the global context throws | `em.transactional()` → savepoint | — |
| TypeORM + `typeorm-transactional` | 1.1.2 / 0.5.0 (2023) | patched repositories, cls-hooked or ALS | buggy `NESTED` | — |
| Prisma | 7.10.1 stable, 8.0.0-rc.33 on `latest` | only through the callback's `tx` client | none | — |
| Drizzle | 0.45.4, 1.0.0-rc.5 | only through `tx` | savepoint | — |

What the explicit-handle ORMs show: Lucid's instance-pinned transaction is the right idea, but users still hit hooks that
escape the transaction ([#1072](https://github.com/adonisjs/lucid/issues/1072)), preloads that ran outside it and then
in parallel on one connection ([#971](https://github.com/adonisjs/lucid/issues/971),
[#1199](https://github.com/adonisjs/lucid/issues/1199); fix merged, unreleased), and after-commit hooks that report
success when Postgres rolled back ([#1205](https://github.com/adonisjs/lucid/issues/1205)). From
`src/transaction_client/index.ts`, Lucid also runs a savepoint's `after('commit')` hooks when the savepoint is released,
not when the outer transaction commits. Prisma has open requests for ambient transactions
([#17215](https://github.com/prisma/orm/issues/17215)); Drizzle's ([#543](https://github.com/drizzle-team/drizzle-orm/issues/543))
has been open since 2023, with the objection that it hides behaviour and does not fit non-Node runtimes.

Known footguns of implicit propagation, and the rule each leads to in the plan:

| Footgun | Rule |
| --- | --- |
| `Promise.all` inside a transaction: all branches join, the driver queues them (until `pg` 9), and when one fails the rollback runs while others still send queries; those fail or, worse, autocommit through the pool (typeorm-transactional #56) | Tenora queues queries per transaction itself, and a closed transaction rejects queries instead of falling back to the pool. |
| Fire-and-forget work started inside a transaction keeps its context after commit | `afterCommit` for side effects, `withoutTransaction()` to opt out, `TransactionClosedError` for late queries. |
| Context lost or stale across callback libraries, event emitters and pooled sockets ([node-postgres #2533](https://github.com/brianc/node-postgres/issues/2533)) | Read the context once at the public call; never inside driver or pool callbacks. |
| One global context across several databases (Sequelize v6's CLS) | Key transactions by connection and tenant. |
| Different default nesting rules everywhere | Pick one (savepoint, as Laravel) and document it. |

Sources: [Lucid transactions](https://lucid.adonisjs.com/docs/transactions), [Lucid models](https://lucid.adonisjs.com/docs/models),
[Sutando transactions](https://sutando.org/guide/transactions.html),
[Sequelize v7 transactions](https://sequelize.org/docs/v7/querying/transactions/),
[MikroORM transactions](https://mikro-orm.io/docs/transactions), [MikroORM identity map](https://mikro-orm.io/docs/identity-map),
[typeorm-transactional](https://github.com/Aliheym/typeorm-transactional),
[Prisma transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions),
[Drizzle transactions](https://orm.drizzle.team/docs/transactions).

## 5. AsyncLocalStorage

- Node 24.0.0 made the `AsyncContextFrame`-based implementation the default
  ([release notes](https://nodejs.org/en/blog/release/v24.0.0), [#55552](https://github.com/nodejs/node/pull/55552)).
  Node 22 still uses the older `async_hooks` one.
- Cost: in [Platformatic's HTTP benchmark](https://blog.platformatic.dev/the-hidden-cost-of-context), a server using
  AsyncLocalStorage kept 90.2% of baseline throughput on Node 22.17 and 93.3% on Node 24.4. No ORM-level benchmark was
  found. One context object is cheaper than several stores.
- `enterWith()` changed behaviour in Node 24 ([#58204](https://github.com/nodejs/node/issues/58204),
  [#62290](https://github.com/nodejs/node/issues/62290)); library code should use `run()` only.
- Context is captured when an async resource is created; EventEmitter listeners can run in a different context
  ([docs](https://nodejs.org/api/async_context.html)). Use `AsyncLocalStorage.snapshot()` or `AsyncResource.bind` at
  callback boundaries.
- Express middleware can call `run(context, next)`; a Fastify `onRequest` hook can call `run(context, done)`.

## 6. Build or wrap

The question: under our own ORM, write the SQL engine ourselves, or use an existing one.

### Kysely

- 0.29.8 (2026-11-01), 0.30.0-beta.2 on `next`. Daily commits, two main maintainers, 14.3k stars. No dependencies.
- **0.x, and minors break**: 0.29.0 went ESM-only and moved the migrator to `kysely/migration`; the 0.28.18 patch
  switched Postgres migration locks to session advisory locks, which break under PgBouncer transaction pooling.
  Downstream projects pin it exactly (MikroORM 7.2.8 pins `0.29.8`).
- Dialects: Postgres (`pg`), MySQL (`mysql2`), SQL Server (`tedious` + `tarn`), SQLite (a better-sqlite3-shaped
  object), PGlite. No MariaDB dialect (MySQL over `mysql2` works against MariaDB servers; the `mariadb` driver does not
  fit). `node:sqlite` only through community dialects or a shim.
- Transactions: `db.transaction().execute(cb)`, controlled transactions with `savepoint`/`rollbackToSavepoint`/
  `releaseSavepoint`. **No nesting** (`trx.transaction()` throws), `releaseSavepoint` unsupported on SQL Server, and
  transaction lifecycle fixes in 0.29.7 (October) and 0.29.8 (November: `AbortedTransactionError` when Postgres turns
  `COMMIT` into a rollback).
- Migrator: `kysely_migration` and `kysely_migration_lock` (renamable), **no batches**, one transaction per run only
  where DDL is transactional (it treats SQLite as not), 451 lines.
- Schema builder: tables, columns, indexes, constraints, views. Column types are strings per dialect; **no SQLite table
  rebuild** (`alterColumn().setDataType()` fails on SQLite).
- **Compile-only use is documented** ([splitting building and execution](https://kysely.dev/docs/recipes/splitting-query-building-and-execution)):
  `Kysely<any>` with a `DummyDriver`, then `.compile()` → `{ sql, parameters }`. Query plugins (`CamelCasePlugin`,
  `WithSchemaPlugin`) still apply.
- **Kysely is a per-dialect compiler, not a portability layer.** Compiling the same builder calls for each dialect,
  it emits SQL the database will reject: `limit/offset` on SQL Server, `returning` on MySQL and SQL Server,
  `onConflict` on MySQL, and passes JavaScript booleans straight through to SQLite drivers that reject them. So the
  dialect rules are ours under any option; Kysely saves the syntax tree, compiler, parameters and DDL text.
- ORMs on Kysely: `kysely-orm` is dead (last release 2023). The mature precedent is existing ORMs that moved onto it:
  **MikroORM 7** (2026-03: "query building is done entirely by MikroORM itself", Kysely runs the queries) and **ZenStack 3**.

**Checked locally for this plan**: Kysely 0.29.8 type-checks under the repo's TypeScript 7.0.2 (`tsc --strict`, no
`skipLibCheck`), and a cold `Kysely<any>` compiles queries and DDL for Postgres, MySQL, SQL Server and SQLite:

```text
pg     select "id", "email" from "users" where "team_id" in ($1, $2) … order by "id" limit $4 offset $5
mysql  select `id`, `email` from `users` where `team_id` in (?, ?) … order by `id` limit ? offset ?
mssql  select "id", "email" from "users" where "team_id" in (@1, @2) … order by "id" offset @4 rows fetch next @5 rows only
sqlite select "id", "email" from "users" where "team_id" in (?, ?) … order by "id" limit ? offset ?
```

A second local check compiled the syntax only some databases have, through the same cold instances (MariaDB through the
MySQL compiler). All of it compiled correctly except two constructs, which Tenora's dialect layer writes as `sql`
templates instead:

| Construct | Result |
| --- | --- |
| `ON CONFLICT … DO UPDATE … RETURNING` (Postgres, SQLite) | correct |
| `ON DUPLICATE KEY UPDATE name = VALUES(name)` (MariaDB) | correct |
| `INSERT … RETURNING` (MariaDB, through the MySQL compiler) | correct |
| `INSERT … OUTPUT inserted.id`, `MERGE … WHEN MATCHED … OUTPUT`, `SELECT TOP(5)` (SQL Server) | correct |
| `FOR UPDATE SKIP LOCKED` (Postgres, MySQL) | correct |
| JSON paths: `->>` (Postgres), `->>'$."key"'` (MySQL, SQLite), `json_value` (SQL Server, via `sql`) | correct |
| DDL: `IDENTITY` and `BIT` (SQL Server), `MODIFY COLUMN` (MySQL), `ALTER COLUMN` (SQL Server), `ADD COLUMN` (SQLite) | correct |
| MySQL row-alias upsert `VALUES (…) AS new ON DUPLICATE KEY UPDATE …` | `AS new` came out after the `ON DUPLICATE KEY` clause: invalid, write as a `sql` template |
| SQL Server table hint `FROM users AS u WITH (UPDLOCK)` | the alias came out after the hint: invalid, write as a `sql` template |

With `Kysely<any>`, SQL Server data types and JSON keys have to be passed as `sql` fragments, which is what a dialect
layer generates anyway.

### What a dialect layer has to handle

| | Postgres | MySQL 8 | MariaDB | SQLite | SQL Server |
| --- | --- | --- | --- | --- | --- |
| Placeholders | `$1` | `?` | `?` | `?` | named, `@1` as Kysely emits them |
| Quoting | `"x"` | `` `x` `` | `` `x` `` | `"x"` | `[x]` |
| Paging | `LIMIT/OFFSET` | same | same | same (`OFFSET` needs `LIMIT`) | `TOP` or `OFFSET … FETCH` (needs `ORDER BY`) |
| Returning rows | `RETURNING` | none: `insertId`, affected rows | `INSERT/DELETE … RETURNING` (10.5+), `UPDATE` only in the newest releases | `RETURNING` (3.35+) | `OUTPUT inserted.*` |
| Upsert | `ON CONFLICT … EXCLUDED` | `ON DUPLICATE KEY UPDATE` with a row alias | `ON DUPLICATE KEY UPDATE … VALUES(x)` | `ON CONFLICT … excluded` | `MERGE` |
| JSON | `->`, `->>`, `@>` | `->>` with `$.path` | `JSON_VALUE` | `->>`, `json_extract` | `JSON_VALUE`, `OPENJSON` |
| Booleans, dates | native | `TINYINT(1)`, `DATETIME` | same | integers; no date type | `BIT`, `datetime2` |
| ALTER TABLE | full, transactional | implicit commit | implicit commit | limited; otherwise the 12-step rebuild ([docs](https://www.sqlite.org/lang_altertable.html)) | defaults and constraints dropped first |

### Sizes, for scale

Non-blank, non-comment JavaScript lines in the published packages:

| Codebase | Lines | Breakdown |
| --- | --- | --- |
| Kysely 0.29.8 | 14.1k | syntax tree 3.4k, builders 1.9k, compiler 1.5k, schema 1.5k, dialects 1.75k, migrator 0.45k |
| Knex 3.3.0 | 18.5k | its SQLite dialect alone is 2.4k, mostly the table rebuild and a parser for stored `CREATE TABLE` text |
| MikroORM 7.2.8 `@mikro-orm/sql` | 17.2k | its own query builder over Kysely execution |

Estimate for our own untyped five-dialect engine: 10–14k lines of TypeScript, plus tests at 1.5–3× that, run against all
five databases. With Kysely compiling, the part we still write (dialect rules, connections and transactions, schema
blueprint with the SQLite rebuild, migrator) is roughly 4–6k lines.

### Other engines

- **Drizzle** has a separate core per dialect built around its own table objects, no neutral syntax tree, SQL Server only
  in the 1.0 betas and no MariaDB core. It is a competitor, not an engine.
- **MikroORM 7** moved from Knex to Kysely in 2026: `@mikro-orm/knex` became `@mikro-orm/sql`, its own query builder
  stayed, Kysely became the query runner, and the migrator is its own.
- **Prisma 7** made the Rust-free client the default with thin driver adapters (`pg`, `mariadb`, `mssql`).
- The direction of the ecosystem: each ORM builds its own SQL in TypeScript and hands the wire protocol to a plain driver.

### Conclusion

A hybrid: Tenora owns the API, dialect rules, connections, transactions, migrator and models, and uses Kysely only to
compile SQL, behind one internal module with an exact pin and per-dialect snapshot tests. Writing the compiler too costs
10–14k lines for no user-visible gain; using Kysely as the whole engine would leave nesting, SQL Server savepoints,
batches, the SQLite rebuild, the `mariadb` driver and `node:sqlite` to work around, in the layer that is Tenora's
product. See [plan.md, The engine](plan.md#the-engine).

Sources: [Kysely releases](https://github.com/kysely-org/kysely/releases), [0.29.0](https://github.com/kysely-org/kysely/releases/tag/v0.29.0),
[dialects](https://kysely.dev/docs/dialects), [migrations](https://kysely.dev/docs/migrations),
[MikroORM 7 release](https://mikro-orm.io/blog/mikro-orm-7-released), [MikroORM v6 → v7](https://mikro-orm.io/docs/upgrading-v6-to-v7),
[Drizzle v1 beta 2](https://orm.drizzle.team/docs/latest-releases/drizzle-orm-v1beta2),
[Prisma 7.0.0](https://github.com/prisma/prisma/releases/tag/7.0.0),
[MySQL upsert](https://dev.mysql.com/doc/refman/8.4/en/insert-on-duplicate.html),
[MariaDB INSERT … RETURNING](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/inserting-loading-data/insertreturning).

## 7. Drivers

| Driver | Latest | Pooling | Notes for the adapter |
| --- | --- | --- | --- |
| `pg` | 8.23.1 | `pg.Pool` | one checked-out client per transaction; release in `finally` ([docs](https://node-postgres.com/features/transactions)) |
| `mysql2` | 3.24.6 | `createPool` | keep `multipleStatements` off except to load a dump; transactions on `getConnection()` |
| `mariadb` | 3.5.5 | `createPool` | ids and big integers as `BigInt`, decimals as strings; session state is not reset when a connection returns to the pool |
| `tedious` | 20.3.8 | none (others use `tarn`) | one request at a time per connection; transactions through its `beginTransaction`/`saveTransaction`/`rollbackTransaction` API ([docs](https://tediousjs.github.io/tedious/api-connection.html)) |
| `better-sqlite3` | 13.0.3 | one synchronous connection | rejects booleans and `Date`; one long transaction blocks every other request on that file |
| `sqlite3` | 6.0.1 | — | **deprecated and unmaintained; repository archived. Drop it.** |
| `node:sqlite` | built in | — | experimental on Node 22; marked release candidate in Node 24.15.0 (2026-04-15, [#61262](https://github.com/nodejs/node/pull/61262), checked in the Node 24 changelog) and 25.7; synchronous; rejects booleans and **silently stores a `Date` as `NULL`** ([docs](https://nodejs.org/api/sqlite.html)) |

Node release lines, from [nodejs.org/dist/index.json](https://nodejs.org/dist/index.json) and the
[release schedule](https://github.com/nodejs/Release): Node 22 ends on 2027-04-30; Node 24 has been in maintenance since
2026-10-20 and ends on 2028-04-30; Node 26 has been the active LTS since 2026-10-28 and ends on 2029-04-30. The latest
releases are 22.23.4, 24.22.2 and 26.13.0.
