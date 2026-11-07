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

## Introspection

Tenora reads a schema back from the database catalog, on all five databases and without dump tools. The schema
builder uses it for `hasTable` and `hasColumn`, and `tenora upgrade` uses it to prove that converted Knex migrations
build the same schema as the originals.

```ts
import { BOOKKEEPING_TABLES, compareSchemas, describeSchema, describeTable, hasColumn, hasTable, listTables } from "@tenora/orm";

await hasTable(db, "users");                                  // true
await hasColumn(db, "users", "email");                        // true
await listTables(db, { exclude: BOOKKEEPING_TABLES });        // without tenora_migrations* and knex_migrations*

await describeTable(db, "posts");
// {
//   name: "posts",
//   columns: [
//     { name: "id", type: "integer", rawType: "integer", length: null, precision: null, scale: null,
//       nullable: false, default: "nextval('posts_id_seq')", autoIncrement: true, primaryKey: true },
//     { name: "title", type: "varchar", rawType: "character varying(200)", length: 200, … },
//     …
//   ],
//   primaryKey: ["id"],
//   indexes: [{ name: "posts_author_id_title_index", columns: ["author_id", "title"], unique: false }],
//   foreignKeys: [{ name: "posts_author_id_foreign", columns: ["author_id"], referencedTable: "users",
//                   referencedColumns: ["id"], onDelete: "set null", onUpdate: "no action" }],
// }

const knexSide = await describeSchema(knexDb, { exclude: BOOKKEEPING_TABLES });
const tenoraSide = await describeSchema(tenoraDb, { exclude: BOOKKEEPING_TABLES });
compareSchemas(knexSide, tenoraSide, { labels: ["Knex", "Tenora"] });
// [
//   'column "posts"."title": type character varying(200) in Knex, character varying(250) in Tenora',
//   'foreign key "posts_author_id_foreign" on "posts": on delete set null in Knex, cascade in Tenora',
//   'column "users"."nickname" exists only in Tenora',
//   'index "users_name_status_index" on "users" (name, status) exists only in Knex',
// ]
```

Everything is scoped to the connection's current schema (`current_schema()` on Postgres, `schema_name()` on SQL
Server), its database (`database()` on MySQL and MariaDB), or SQLite's main database, and joins the ambient
transaction, so a migration sees the tables it has just created. Table names match as the database matches them;
`hasColumn` matches column names exactly on Postgres and ignores case elsewhere (on SQL Server, as the collation
says). `describeTable` throws for a table that does not exist. `exclude` takes exact names, patterns where `*` matches
anything, and regular expressions, and ignores case.

What a column reports:

- `rawType` is the type as the database spells it (`character varying(255)`, `int unsigned`, `nvarchar(max)`), and
  `type` its lowercase base (`varchar`, `int`, `nvarchar`); Postgres's long names are shortened to `varchar`, `char`,
  `timestamp`, `timestamptz`, `time`, `timetz` and `varbit`. `length` is set for sized character and binary types,
  `precision` and `scale` for decimals, and `precision` alone for fractional seconds where the type declares them.
- `default` is the expression the database reports, lightly normalized: Postgres's casts on literals go
  (`'new'::character varying` → `'new'`, `nextval('posts_id_seq'::regclass)` → `nextval('posts_id_seq')`); MySQL's
  unquoted literals are quoted as MariaDB quotes them (`new` → `'new'`); MariaDB's `NULL` for "no default" becomes
  `null`; SQL Server's wrapping parentheses go (`((0))` → `0`, `(getdate())` → `getdate()`). Expressions keep each
  database's spelling (`CURRENT_TIMESTAMP` on MySQL, `current_timestamp()` on MariaDB).
- `autoIncrement` is a Postgres identity column or `nextval()` default (`serial`), MySQL's `auto_increment`, SQL
  Server's `identity`, and SQLite's `AUTOINCREMENT` keyword. A plain SQLite `INTEGER PRIMARY KEY` also gets row ids,
  but may reuse them, so it is not auto-increment; it is reported as not nullable, since the rowid cannot be null.
  A Postgres identity column has no default and a `serial` keeps its `nextval()`, so the two stay apart.

Dialect notes:

- MariaDB stores `json` as `longtext` with a `json_valid()` check; such a column has `type: "json"` and
  `rawType: "longtext"`.
- MySQL and MariaDB create an index for a foreign key that no index starts with; it is listed like any other. A
  prefix index shows its key as `email(191)`, and an expression key (Postgres, MySQL 8, SQLite) as its SQL text.
- SQLite's pragmas have no constraint names, so foreign key names are read from the `CREATE TABLE` statement SQLite
  keeps; a foreign key declared without a name has `name: null`. The index behind a `UNIQUE` constraint has the name
  SQLite gives it, `sqlite_autoindex_<table>_<n>`.
- SQL Server names unnamed constraints itself, with a random suffix (`FK__posts__autho__3B75D760`). Such indexes and
  foreign keys carry `systemNamed: true`, and `compareSchemas` treats two such names as equal.

`compareSchemas(a, b, options?)` compares two described schemas of the same dialect and returns sentences, empty when
they match: tables, columns, indexes and foreign keys on one side only, and changed types, nullability, defaults,
auto-increment, primary keys, uniqueness and referential actions. Types and defaults are compared as the database
reports them, which is why both sides must come from the same dialect. The order of tables, columns, indexes and
foreign keys is not compared. Index and foreign key names matter unless `ignoreNames: true`, which matches them by the
columns they cover. `labels` names the two sides in the sentences (default `["a", "b"]`).

Not compared yet: check constraints, partial index conditions (including the `WHERE … IS NOT NULL` filter Knex adds to
unique indexes on SQL Server), whether a unique key is a constraint or an index, index sort order, MySQL's
`ON UPDATE CURRENT_TIMESTAMP`, generated columns, collations and comments.
