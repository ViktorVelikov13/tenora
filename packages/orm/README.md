# @tenora/orm

The database layer of Tenora 1.0: connections, a query builder in the style of Laravel's, and transactions that queries
join on their own. It is being built on the `next` branch; see [the plan](../../docs/orm/plan.md). Models and tenancy
come in later phases.

Status: every database Tenora supports works and is tested: Postgres (`pg`), MySQL (`mysql2`), MariaDB (`mariadb`, or
`mysql2` with `dialect: "mariadb"`), SQLite (`better-sqlite3`) and SQL Server (`tedious`, with `client: "mssql"`).

## Connecting

```ts
import { createConnection, sql } from "@tenora/orm";

const db = createConnection({
  client: "pg", // or "mysql2", "mariadb", "better-sqlite3", "mssql"
  connection: { host, port, user, password, database }, // passed to the driver; { filename } for SQLite
  pool: { max: 10 },
});
```

For SQL Server the connection takes the shape 0.x configs use: `{ server, port, user, password, database, options }`,
where `options` goes to tedious (for example `{ encrypt: false, trustServerCertificate: true }`). tedious has no pool of
its own, so Tenora pools its connections.

Install the driver yourself (`npm install pg`). It is loaded from your project, so a globally installed CLI uses it too.

## Queries

The builder follows Laravel's: if you know `DB::table()`, you know this. Every method returns a new builder, so a base
query can be reused, and awaiting a builder runs it. `toSql()` shows the SQL and parameters without running anything.
For the same reason a callback returns the builder it is given, `(q) => q.where(...)`, rather than changing it in place
as Laravel's do; forgetting the `return` gets a clear error.

```ts
const users = await db.table("users").where("active", true).orderBy("name").limit(20);
const ada = await db.table("users").find(1);
const email = await db.table("users").where("name", "ada").value("email");
const names = await db.table("users").pluck("name");
```

### Filtering

```ts
db.table("users")
  .where("votes", 100)                       // =, or any operator: where("votes", ">=", 100)
  .where((q) => q.where("role", "admin").orWhere("role", "owner"))   // a group in parentheses
  .whereIn("team_id", [1, 2, 3])            // also whereNotIn, orWhereIn
  .whereNull("deleted_at")                   // where("deleted_at", null) means the same
  .whereBetween("age", [18, 65])
  .whereColumn("updated_at", ">", "created_at")
  .whereRaw(sql`lower(${sql.ref("email")}) = ${email}`)
  .when(search, (q, term) => q.where("name", "like", `%${term}%`));   // only when search is set
```

### Joins

```ts
db.table("orders as o")
  .join("customers as c", "c.id", "o.customer_id")                  // inner join; an operator can go in the middle
  .leftJoin("notes", (j) => j.on("notes.order_id", "o.id").where("notes.kind", "public"))
  .select("o.id", "c.name");
```

`on` compares two columns; `where` inside a join compares a column with a value. `rightJoin`, `crossJoin`, `joinSub`
and `leftJoinSub` work the same way.

### Subqueries

A subquery is just another builder on the same connection:

```ts
const big = db.table("orders").select("customer_id").where("total", ">", 100);
await db.table("customers").whereIn("id", big);
await db.table("customers").whereNotExists(db.table("orders").whereColumn("orders.customer_id", "customers.id"));

await db.table("customers")
  .select("name")
  .selectSub(db.table("orders").selectRaw(sql`count(*)`).whereColumn("orders.customer_id", "customers.id"), "orders");

const spent = db.table("orders").select("customer_id").selectRaw(sql`sum(${sql.ref("total")}) as spent`).groupBy("customer_id");
await db.fromSub(spent, "t").where("t.spent", ">", 500);
await db.table("customers as c").joinSub(spent, "t", "t.customer_id", "c.id");
```

A builder from another connection is refused: a tenant query inside a base query would be two databases.

### Grouping and aggregates

```ts
await db.table("orders").count();             // a number, also on Postgres
await db.table("orders").sum("total");        // a number, or null when no rows match
await db.table("orders").avg("total");
await db.table("orders").min("created_at");   // as stored: a date stays a date
await db.table("orders").where("total", ">", 100).exists();

await db.table("orders")
  .select("customer_id")
  .selectRaw(sql`count(*) as orders`)
  .groupBy("customer_id")
  .havingRaw(sql`sum(${sql.ref("total")}) > ${500}`);
```

`count()` on a grouped, distinct or unioned query counts the rows it returns, not the first group. `having(column, …)`
works too, but Postgres does not accept a select alias there; `havingRaw` with the expression works everywhere. SQL
Server averages an integer column as an integer, so `avg()` of an `int` column loses its fraction there.

### Ordering, paging and unions

```ts
db.table("users").orderBy("name").orderByDesc("created_at");   // also latest(), oldest(), inRandomOrder()
db.table("users").forPage(2, 20);                                // rows 21 to 40
db.table("users").limit(10).offset(30);

const queued = db.table("orders").select("id").where("status", "queued");
await queued.union(db.table("orders").select("id").where("status", "late")).orderBy("id").limit(10);
```

`orderBy` and `limit` on a union apply to the combined rows; the queries passed to `union()` cannot have their own.

### Writing

```ts
const id = await db.table("users").insertGetId({ name: "ada" });
await db.table("users").insert([{ name: "bob" }, { name: "cy" }]);   // returns how many were inserted
await db.table("users").where("id", id).update({ name: "Ada" });     // returns how many changed
await db.table("users").where("id", id).increment("logins");          // also decrement
await db.table("users").where("active", false).delete();

// Insert, or update the existing row with the same unique key
await db.table("users").upsert([{ email: "ada@x", name: "Ada" }], "email");             // updates every other column
await db.table("users").upsert([{ email: "ada@x", name: "Ada" }], "email", ["name"]);   // updates only these
await db.table("users").upsert([{ email: "ada@x", name: "Ada" }], "email", []);         // leaves existing rows alone
```

Postgres and SQLite need a unique index on exactly the `uniqueBy` columns; MySQL and MariaDB use whichever unique key
the row conflicts with; SQL Server runs a `MERGE`.

### Locking

```ts
await db.transaction(async () => {
  const job = await db.table("jobs").where("status", "queued").forUpdate().skipLocked().first();
  // ...
});
```

`forUpdate()` locks the rows until the transaction ends, `sharedLock()` lets others read but not change them, and
`skipLocked()` skips rows another transaction holds, which makes a simple job queue. SQL Server gets these as table
hints on the main table; SQLite needs none, because a transaction already locks the database.

### Raw SQL

```ts
await db.raw(sql`select * from ${sql.ref("users")} where lower(name) = ${name}`);
```

Values in a `sql` template are bound as parameters; `sql.ref()` quotes an identifier; `sql.raw()` inserts trusted text
as is and must never get user input.

## Transactions

```ts
import { afterCommit, withoutTransaction } from "@tenora/orm";

await db.transaction(async () => {
  const id = await db.table("orders").insertGetId({ customer_id });
  await db.table("stock").where("sku", sku).decrement("qty");          // joins the transaction
  await Promise.all(items.map((item) => db.table("order_items").insert({ ...item, order_id: id })));
  afterCommit(() => mailer.send(orderPlaced(id)));                    // only after COMMIT
}, { attempts: 3 });                                                  // retried after a deadlock
```

What happens, and why:

- Every query on `db` inside the callback runs in the transaction, without a handle being passed around.
- A `transaction()` inside another is a savepoint: its failure rolls back only its own work. Sibling nested
  transactions run one after the other.
- Queries are queued on the transaction's connection, so `Promise.all` inside a transaction is safe.
- A query that runs after its transaction ended throws `TransactionClosedError`; it never runs outside the transaction.
- Queries still queued when a transaction rolls back are rejected, not run.
- A COMMIT that Postgres turns into a rollback throws `TransactionAbortedError`; a connection lost during COMMIT throws
  `TransactionOutcomeUnknownError`. In both cases no `afterCommit` callback runs.
- `attempts` re-runs the whole callback after a deadlock or serialization failure, on the outermost transaction only.
- `withoutTransaction(fn)` runs `fn` outside the transaction, for writes that must survive a rollback.
- `db.beginTransaction()` returns a handle for code that cannot use a callback: `db.table("x").using(trx)`,
  `trx.run(fn)`, `trx.commit()`, `trx.rollback()`.

On SQLite there is one connection, so a query outside an open transaction waits until it ends.

## Migrations

A migration is a file that exports `up` and `down`. Both get a context whose `db` is the connection; every query on it
joins the migration's transaction.

```ts
// migrations/20261107120000_create_orders.ts
import { migration, sql } from "@tenora/orm";

export default migration({
  async up({ db }) {
    await db.raw(sql`create table orders (id integer primary key, total integer not null)`);
    await db.table("settings").insert({ key: "orders", value: "on" });
  },
  async down({ db }) {
    await db.raw(sql`drop table orders`);
  },
});
```

```ts
import { createMigrator } from "@tenora/orm";

const migrator = createMigrator(db, { directory: "migrations" });

await migrator.latest();                 // { batch: 3, migrations: ["20261107120000_create_orders"] }
await migrator.rollback();               // the last batch, newest first: { batches: [3], migrations: [...] }
await migrator.rollback({ step: 2 });    // the last two migrations, across batches
await migrator.rollback({ all: true });
await migrator.status();                 // { ran: [{ name, batch, migratedAt, source, file }], pending: [{ name, file }] }
await migrator.forceUnlock();            // after a run was killed while it held the lock
```

Files can be `.js`, `.mjs`, `.cjs` or `.ts` (or `.mts` and `.cts`; Node strips the types), ESM or CommonJS. Besides
`export default migration({...})` and `module.exports = migration({...})`, plain `up` and `down` exports work, and so
does Knex's `exports.config = { transaction: false }`. Files from all `directories` run as one list, sorted by file name
the way Knex sorts them (by code unit, so `B` comes before `a`); a timestamp prefix keeps them in the order they were
written.

What happens, and why:

- The bookkeeping lives in the database itself: `tenora_migrations (id, name, batch, migrated_at, source)` and
  `tenora_migrations_lock`, created on first use. `table: "app_migrations"` renames both. Knex's `knex_migrations` is
  never read or written.
- Names are stored without their extension, so renaming a migration from `.js` to `.ts` does not make it new again.
- Each `latest()` records its migrations as one batch, and `rollback()` undoes the last batch, as in Knex. `step: n`
  undoes the last n migrations instead, as in Laravel.
- On Postgres, SQLite and SQL Server each migration runs in its own transaction, together with its record: one that
  fails is undone and not recorded. MySQL and MariaDB commit DDL as they run it, so there a migration that fails halfway
  keeps what it did before the failure; keep MySQL migrations to one change each.
- `migration({ transaction: false, ... })` runs a migration outside a transaction, for statements a database refuses
  inside one, such as Postgres's `create index concurrently`.
- A failing migration stops the run with a `MigrationError` that names the file (`migration`, `file`, `direction`, and
  the database's error as `cause`). The migrations before it in the batch stay recorded.
- One migrator runs at a time per database. The lock is a row in the lock table, not a Postgres advisory lock, which
  breaks under PgBouncer. A second migrator gets a `MigrationLockError`; if a run was killed while it held the lock,
  `forceUnlock()` releases it.
- `rollback()` first checks that every migration it would undo has a `down` and still has its file, so it never stops
  halfway for either reason. A migration pruned into a schema dump cannot be rolled back; give a one-way migration an
  empty `down` to allow it.
- The migrator runs outside any transaction open around the call: the lock and each migration's transaction are its own.
  On SQLite that transaction holds the only connection, so do not call the migrator inside one.
- `context: (db) => ({ ... })` adds to what `up` and `down` receive, next to `db`.

### Seeds

```ts
// seeds/01_users.ts
import { seed } from "@tenora/orm";

export default seed(async ({ db }) => {
  await db.table("users").insert([{ name: "ada" }, { name: "bob" }]);
});
```

```ts
import { createSeeder } from "@tenora/orm";

const seeder = createSeeder(db, { directory: "seeds" });
await seeder.run();                        // { seeds: ["01_users", "02_teams"] }
await seeder.run({ only: "02_teams" });    // with or without the extension
```

Seeds run in file name order, each in its own transaction on every database: they change data, which all five can roll
back. `seed(fn, { transaction: false })` opts out. `exports.seed = async ({ db }) => ...` and a default-exported
function work too. Seeds are not recorded, so each `run()` runs them all again. A seed that throws stops the run with a
`SeedError`; the seeds before it stay committed.
