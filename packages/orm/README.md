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

## Schema

`db.schema` creates and changes tables in the style of Laravel's schema builder. Awaiting a change runs it; `toSql()`
shows its statements without running anything.

```ts
await db.schema.create("orders", (t) => {
  t.id();                                                       // bigint auto-increment primary key
  t.foreignId("customer_id").constrained().cascadeOnDelete();   // references customers(id)
  t.decimal("total", 12, 2).default(0);
  t.string("status", 20).default("new").index();
  t.json("meta").nullable();
  t.timestamps();
  t.softDeletes();
});

await db.schema.table("orders", (t) => {
  t.string("note").nullable();                // a new column
  t.string("status", 40).change();            // a changed one: this definition replaces the old one
  t.renameColumn("meta", "details");
  t.dropColumn("deleted_at");
  t.unique(["customer_id", "status"]);
  t.dropForeign(["customer_id"]);             // by its columns, or by name: dropForeign("orders_customer_id_foreign")
});

await db.schema.rename("orders", "purchases");
await db.schema.dropIfExists("purchases");    // also drop(table)
```

Columns: `id()`, `increments`, `bigIncrements`, `string(name, length = 255)`, `text`, `integer`, `unsignedInteger`,
`bigInteger`, `unsignedBigInteger`, `smallInteger`, `boolean`, `decimal(name, precision = 8, scale = 2)`,
`float(name, precision = 53)`, `double`, `date`, `dateTime`, `timestamp` and `time` (with a precision, 0 by default as
in Laravel; pass 3 to keep milliseconds), `json`, `uuid`, `binary`, `enum(name, values)`, `foreignId(name)`,
`timestamps()`, `softDeletes()`.

Column modifiers: `nullable()`, `default(value)` (a value, or a `sql` fragment written as is), `useCurrent()`,
`unsigned()` (MySQL and MariaDB only), `unique(name?)`, `index(name?)`, `primary()`, `change()`. A foreign id gets
`.constrained(table?, column = "id")`, whose table defaults to the plural of the column name without `_id` (`team_id`
→ `teams`; pass the table when the plural is irregular), then `cascadeOnDelete()`, `nullOnDelete()`,
`restrictOnDelete()`, `noActionOnDelete()`, the same `…OnUpdate()` methods, or `onDelete(action)`.

Table methods: `index(columns, name?)`, `unique(columns, name?)`, `primary(columns, name?)`,
`foreign(columns, name?).references(column).on(table)`, `dropColumn(...columns)`, `renameColumn(from, to)`,
`dropIndex`, `dropUnique`, `dropForeign` (each by name, or by columns), `dropPrimary()`, `dropConstrainedForeignId`,
`dropTimestamps()`, `dropSoftDeletes()`.

Keys and indexes are named as Laravel names them: `orders_status_index`, `users_email_unique`,
`orders_customer_id_foreign`. A primary key is `users_pkey` on Postgres, as Postgres itself names it.

| Method | Postgres | MySQL, MariaDB | SQLite | SQL Server |
| --- | --- | --- | --- | --- |
| `id()`, `bigIncrements` | `bigserial` | `bigint unsigned auto_increment` | `integer autoincrement` | `bigint identity` |
| `increments` | `serial` | `int unsigned auto_increment` | `integer autoincrement` | `int identity` |
| `string(n)` | `varchar(n)` | `varchar(n)` | `varchar` | `nvarchar(n)` |
| `text` | `text` | `text` | `text` | `nvarchar(max)` |
| `boolean` | `boolean` | `tinyint(1)` | `tinyint(1)` | `bit` |
| `decimal(p, s)` | `decimal(p, s)` | `decimal(p, s)` | `numeric` | `decimal(p, s)` |
| `dateTime(p)`, `timestamp(p)` | `timestamp(p) without time zone` | `datetime(p)`, `timestamp(p)` | `datetime` | `datetime2(p)` |
| `json` | `json` | `json` | `text` | `nvarchar(max)` |
| `uuid` | `uuid` | `char(36)` | `varchar` | `uniqueidentifier` |
| `binary` | `bytea` | `blob` | `blob` | `varbinary(max)` |
| `enum(values)` | `varchar(255)` with a check | `enum(…)` | `varchar` with a check | `nvarchar(255)` with a check |
| `foreignId` | `bigint` | `bigint unsigned` | `integer` | `bigint` |

`change()` works as in Laravel: the new definition replaces the old one, so a modifier you want to keep (`nullable()`,
`default()`) has to be given again; the column's indexes and foreign keys stay. On SQL Server a default is a named
constraint (`orders_status_default`), which `change()` and `dropColumn()` drop first.

### SQLite table rebuilds

SQLite alters little in place. Adding, renaming and dropping an unconstrained column run as they are; changing a
column, dropping a column that a key or index uses, and adding or dropping a foreign or primary key rebuild the table,
following [SQLite's 12 steps](https://www.sqlite.org/lang_altertable.html#otheralter): foreign key enforcement off
before the transaction, a new table, the rows copied, the old table dropped and the new one renamed, its indexes and
triggers created again, and the foreign keys checked before the commit. The definition comes from the table's pragmas
and its CREATE TABLE text, and column definitions the change does not touch are kept as written. `toSql()` shows a
rebuild as a comment, since it reads the table when it runs.

SQLite ignores the foreign key switch inside a transaction, and with enforcement on, dropping the old table would
delete the rows that reference it through `ON DELETE CASCADE`. So inside a transaction a rebuild goes ahead only when
no table references the one being rebuilt, and fails with an explanation otherwise. Code that has to rebuild a
referenced table in a transaction (a migration, say) switches enforcement off around it:

```ts
await db.schema.withoutForeignKeyConstraints(() =>   // SQLite only
  db.transaction(async () => {
    await db.schema.table("users", (t) => t.string("name", 100).change());
  })
);
```

### Transactions

Schema changes run in the transaction open on the connection, like queries, and a change returned unawaited from a
`transaction()` callback still runs in it: a change runs in the async context it was created in. Postgres, SQLite and
SQL Server roll DDL back with the transaction. **MySQL and MariaDB commit DDL implicitly**: a schema change there ends
the open transaction, and it cannot be rolled back.

### Knex-compatible schema builder

Migrations converted from 0.x use `db.schema.knex` (with `migration({ compat: "knex" })`). It has Knex's method names
and semantics, and writes exactly the SQL Knex 3.3 wrote on each database, so tenants migrated before and after the
upgrade end up with the same schema.

```js
await db.schema.knex.createTable("orders", (t) => {
  t.increments("id").primary();
  t.integer("customer_id").unsigned().notNullable().references("id").inTable("customers").onDelete("CASCADE");
  t.decimal("total", 12, 2).notNullable().defaultTo(0);
  t.timestamps(true, true);
});
```

- Tables: `createTable`, `createTableIfNotExists`, `alterTable` (or `table`), `dropTable`, `dropTableIfExists`,
  `renameTable`, `raw`. Calls chain as in Knex, and `toSQL()` returns what Knex's `toSQL()` returns. Unlike Knex's,
  every call returns a new builder, so separate calls on one `schema` never run each other's statements.
- Columns: `increments`, `bigIncrements`, `integer`, `bigInteger`, `smallint`, `tinyint`, `string`, `text`, `boolean`,
  `date`, `datetime`, `timestamp`, `time`, `timestamps(useTimestamps, defaultToNow)`, `decimal`, `float`, `double`,
  `json`, `jsonb`, `uuid`, `enu`, `binary`, `specificType`.
- Chains: `primary`, `notNullable`, `nullable`, `defaultTo` (a value, or a `sql` fragment for `knex.raw`/`knex.fn.now()`),
  `unique`, `index`, `unsigned`, `references().inTable().onDelete()`, `onUpdate`, `withKeyName`, `alter()`.
- Table methods: `index`, `unique`, `primary`, `foreign`, `dropColumn(s)`, `renameColumn`, `dropForeign`, `dropIndex`,
  `dropUnique`, `dropPrimary`, `dropTimestamps`, and on MySQL `engine`, `charset`, `collate`.
- Knex added the `charset` and `collate` of a MySQL connection config to every CREATE TABLE. Pass them on:
  `db.schema.knex.withOptions({ charset: "utf8mb4", collate: "utf8mb4_unicode_ci" })`.

Where Knex read the database before altering, this does the same work: a MySQL column rename reads the column with
`SHOW FULL FIELDS` and rewrites it with `CHANGE`, dropping and restoring the foreign keys that point at the table, and
most SQLite alterations rebuild the table as Knex did, keeping an index on a dropped column with its other columns, and
(as Knex did) not recreating triggers. The resulting catalog is Knex's; the CREATE TABLE text SQLite stores after a
rebuild is formatted differently. Not offered: column `comment`, `collate`, `first`, `after` and `check…` modifiers,
`setNullable`/`dropNullable`, index predicates, and `hasTable`/`hasColumn`.
