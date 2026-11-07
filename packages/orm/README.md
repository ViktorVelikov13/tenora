# @tenora/orm

The database layer of Tenora 1.0: connections, a query builder in the style of Laravel's, transactions that queries
join on their own, migrations, catalog introspection and Eloquent-style models. It is being built on the `next` branch;
see [the plan](../../docs/orm/plan.md). Still to come: the schema builder, model relations, and tenancy.

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
//   checks: [{ name: "posts_status_check", expression: "status = ANY (ARRAY['draft'::text, 'published'::text])" }],
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

Indexes leave out the primary key's own index and list unique constraints as unique indexes. A partial (filtered)
index has its condition in `where`, as the database reports it: `external_id IS NOT NULL` on Postgres,
`[external_id] IS NOT NULL` on SQL Server (where Knex's `unique()` makes one), the text of the `CREATE INDEX` on
SQLite. `checks` lists check constraints with their condition, without `CHECK` and its parentheses, in each
database's words; Knex's `enu()` is one on Postgres and SQLite.

Dialect notes:

- MariaDB stores `json` as `longtext` with a `json_valid()` check; such a column has `type: "json"` and
  `rawType: "longtext"`, and the check is not listed. MySQL's escaped quotes in a check (`_utf8mb4\'new\'`) are
  unescaped.
- MySQL and MariaDB create an index for a foreign key that no index starts with; it is listed like any other. A
  prefix index shows its key as `email(191)`, and an expression key (Postgres, MySQL 8, SQLite) as its SQL text.
- SQLite's pragmas have no constraint names and no checks, so foreign key names and check constraints are read from
  the `CREATE TABLE` statement SQLite keeps; a constraint declared without a name has `name: null`. The index behind a
  `UNIQUE` constraint has the name SQLite gives it, `sqlite_autoindex_<table>_<n>`.
- SQL Server names unnamed constraints itself, with a random suffix (`FK__posts__autho__3B75D760`). Such indexes,
  foreign keys and checks carry `systemNamed: true`, and `compareSchemas` treats two such names as equal.

`compareSchemas(a, b, options?)` compares two described schemas of the same dialect and returns sentences, empty when
they match: tables, columns, indexes, foreign keys and checks on one side only, and changed types, nullability,
defaults, auto-increment, primary keys, uniqueness, index conditions, referential actions and check conditions. Types,
defaults and conditions are compared as the database reports them, which is why both sides must come from the same
dialect. The order of tables, columns, indexes, foreign keys and checks is not compared. Their names matter unless
`ignoreNames: true`, which matches them by what they cover. `labels` names the two sides in the sentences (default
`["a", "b"]`).

Not compared yet: whether a unique key is a constraint or an index, index sort order and type (`gin`, `hash`),
MySQL's `ON UPDATE CURRENT_TIMESTAMP`, SQL Server's default constraint names, generated columns, collations and
comments.

## Models

Models follow Eloquent's: a class per table, static fields for its configuration, and queries that return instances.
Fields are declared with `declare`, so the class adds no properties of its own; in plain JavaScript, leave them out.

```ts
import { cast, type Casts, Model, scope } from "@tenora/orm";

export class User extends Model {
  static table = "users";                 // default: the snake_case plural of the class name
  static connection = "tenant";           // the name the connection resolver gets; default "default"
  static fillable = ["name", "email", "settings"];
  static hidden = ["password"];
  static casts = { isAdmin: "boolean", settings: cast.json<UserSettings>(), lastSeenAt: "datetime" } satisfies Casts<User>;
  static softDeletes = true;              // deletedAt, hidden from queries unless asked for
  // timestamps are on by default: createdAt, updatedAt

  static active = scope<User>((query) => query.where("isAdmin", true));

  declare id: number;
  declare name: string;
  declare email: string;
  declare isAdmin: boolean;
  declare settings: UserSettings;
  declare lastSeenAt: Date | null;
  declare createdAt: Date;

  static {
    this.creating((user) => {
      user.email = user.email.toLowerCase();
    });
  }
}

const admins = await User.query().apply(User.active).where("createdAt", ">", lastWeek).orderBy("name").get();
const user = await User.findOrFail(id);
user.fill(body);                          // only fillable keys; others throw in strict mode
if (user.isDirty("email")) user.isAdmin = false;
await user.save();                        // UPDATE only the changed columns
```

The static fields, all optional:

| Field | Default | |
| --- | --- | --- |
| `table` | snake_case plural of the class name | set it in code that gets minified, which renames classes |
| `primaryKey`, `incrementing` | `"id"`, `true` | with `incrementing = false` the key is yours to set (a code, a UUID) |
| `connection` | `"default"` | see [Model connections](#model-connections) |
| `fillable`, `guarded` | `[]`, `["*"]` | what `fill()` and `create()` may set |
| `hidden`, `visible`, `appends` | `[]` | what `toJSON()` leaves out, keeps, and adds from getters |
| `casts` | `{}` | see [Attributes and casts](#attributes-and-casts) |
| `timestamps`, `CREATED_AT`, `UPDATED_AT` | `true`, `"createdAt"`, `"updatedAt"` | set one name to `null` to leave it out |
| `softDeletes`, `DELETED_AT` | `false`, `"deletedAt"` | |
| `naming` | `naming.snakeCase` | `naming.none` uses the column names as attribute names |
| `strict` | `true` | see [Strict mode](#strict-mode) |
| `perPage` | `15` | for `paginate()` |
| `globalScopes` | `{}` | see [Scopes](#scopes) |

Attributes are camelCase and columns snake_case: `createdAt` is `created_at`, in rows read and written and in the
column names of a model query (`where`, `orderBy`, `select`, `pluck`, `groupBy`, aggregates), qualified ones too
(`"users.teamId"`). Raw fragments and join callbacks take the database's names.

An instance's attributes are its own properties, so `{ ...user }`, `console.log(user)` and `JSON.stringify(user)` show
them. Every own property is saved as a column; keep other state in `#private` fields. A column whose attribute would
hide a method or getter of the model (a `save` column, say) is refused with an error; select it under another name.

### Model connections

A model query runs on, in order:

1. an explicit connection: `User.on(db)`, or `User.using(trx)` for a transaction from `db.beginTransaction()`;
2. for an instance, the database it was loaded from or saved to, even if the declared one now resolves elsewhere;
3. the declared `connection` name, resolved by the function given to `setConnectionResolver`.

```ts
import { setConnectionResolver } from "@tenora/orm";

setConnectionResolver((name) => (name === "default" ? db : undefined));
```

Tenancy registers a resolver that knows the current tenant. A name the resolver does not know, or no resolver, throws:
a model never falls back to another database. The resolver runs when the query is created (`User.query()`,
`User.where(…)`), not when it is awaited, so build a query inside the context it should run in. Inside `db.transaction()`, model queries, saves and the events they
fire join the transaction like any other query. An instance remembers its database, not its transaction: one loaded
before a transaction and saved inside it joins it, and one loaded inside and saved after it commits runs outside it.
Only `user.using(trx)` pins a transaction on an instance; `User.using(trx)` runs one query in it.

### Model queries

`User.query()` returns a model query: the query builder's methods (`where*`, joins, `orderBy`, `limit`, `when`,
unions, locks, …) with attribute names mapped, plus:

```ts
await User.find(1);                    // or undefined; find([1, 2]) returns an array
await User.findOrFail(1);              // throws ModelNotFoundError, with .ids
await User.findMany([1, 2]);
await User.all();
await User.where("teamId", 1).first(); // also firstOrFail()
await User.where({ teamId: 1, isAdmin: false }).get();
await User.where("teamId", 1).count(); // also exists(), sum(), avg(), min(), max()
await User.query().pluck("email");     // through the attribute's cast
await User.query().paginate({ page: 2, perPage: 20 }); // { data, total, page, perPage, lastPage }

await User.query().chunkById(500, async (users, page) => { /* return false to stop */ });
for await (const user of User.where("isAdmin", true).lazyById()) { /* one at a time, read 1000 per query */ }
```

`chunkById` and `lazyById` read each chunk after the last key of the one before, so rows changed or deleted on the
way do not shift the chunks; they order by the key themselves and refuse a query with `orderBy`, `limit` or `offset`.
The common ones are static shortcuts too: `User.where(…)`, `User.whereIn(…)`, `User.orderBy(…)`, `User.latest()`,
`User.count()`, `User.paginate()`, … A model query can be a subquery: `User.whereIn("id", Post.query().select("userId"))`.
`toBase()` gives the plain query builder, with the global scopes applied.

Mass updates and deletes run one statement and **fire no model events**, as in Eloquent. They set `updatedAt`, and
with soft deletes `delete()` sets `deletedAt`:

```ts
await User.where("lastSeenAt", "<", cutoff).update({ isAdmin: false });
await User.where("teamId", 7).increment("votes");
await User.where("teamId", 7).delete();
await User.query().upsert([{ email: "ada@x", name: "Ada" }], "email");
```

To fire events, load the models and save or delete each one, or use `User.destroy(ids)`.

### Attributes and casts

`fill()`, `create()` and `new User(attributes)` set only fillable attributes. With the defaults (`fillable` empty,
`guarded = ["*"]`) a model allows no mass assignment and `fill()` throws; list the attributes in `fillable`, or set
`guarded = []` to allow every one. `forceFill()` and plain assignment skip the check.

Casts convert between what the database returns and what an attribute holds:

| Cast | Attribute | Notes |
| --- | --- | --- |
| `"boolean"` | `boolean` | from 1/0 (SQLite, MySQL) and bit (SQL Server) |
| `"integer"`, `"float"` | `number` | |
| `"string"` | `string` | |
| `"json"`, `cast.json<T>()` | `T` | text on SQLite, SQL Server and MariaDB; parsed by the driver on Postgres and MySQL |
| `"datetime"` | `Date` | SQLite stores milliseconds since the epoch, as 0.x did |
| `"date"` | `"YYYY-MM-DD"` string | a JavaScript Date always has a time and a timezone, so a day is a string |
| `{ get, set }` | what `get` returns | `{ get: (value) => new Money(value), set: (money) => money.cents }` |

Null passes through without calling the cast. `createdAt`, `updatedAt` and `deletedAt` are datetimes without a
declared cast. Casts run when a model is read and written; in between, an attribute holds what was assigned to it.
`satisfies Casts<User>` checks the casts against the declared fields, typos included; without it, write the object
`as const`, since TypeScript would otherwise widen `"boolean"` to `string`.

Changes are tracked against the values last read or saved, compared by what the cast would write (so `1` and `true`
under a boolean cast are no change) and JSON by content, including edits in place (`user.settings.tabs.push(…)`):

```ts
user.isDirty();            // anything changed; also isDirty("email") or isDirty(["email", "name"])
user.isClean("email");
user.getDirty();           // { email: "new@x" }
user.getOriginal("email"); // the value read
await user.save();         // writes only the dirty columns; nothing at all when none changed
user.wasChanged("email");  // what that save changed; getChanges() lists them
```

`save()` inserts a new model (reading back its generated key) or updates the changed columns of a loaded one, by the
key it was read with. Timestamps are whole seconds, as Laravel stores them, so every column type keeps the value in
memory exactly. `undefined` counts as not set; assign `null` to clear a column.

### Writing models

```ts
const user = await User.create({ name: "Ada", email: "ada@x" });
await user.update({ name: "Ada L." });   // fill(), then save()
await user.touch();                      // updatedAt = now
await user.refresh();                    // read the row again; fresh() returns a new instance instead
await user.delete();

await User.firstOrCreate({ email }, { name });   // find by the first, or create with both
await User.createOrFirst({ email }, { name });   // insert, or return the row a unique key already holds
await User.updateOrCreate({ email }, { name });
await User.firstOrNew({ email }, { name });      // unsaved when not found
```

`createOrFirst` (which `firstOrCreate` uses when nothing is found) inserts in a transaction of its own, or a savepoint
inside an open one, so a unique violation from a concurrent insert does not abort the surrounding transaction on
Postgres; it then reads the existing row.

### Soft deletes

With `static softDeletes = true`, `delete()` sets `deletedAt` and queries leave those rows out:

```ts
await post.delete();               // UPDATE … SET deleted_at; post.trashed() is true
await Post.withTrashed().get();    // deleted rows too
await Post.onlyTrashed().get();
await post.restore();
await post.forceDelete();          // DELETE
await Post.onlyTrashed().where("userId", id).restore();   // in bulk, without events
```

The condition is a global scope named `"softDeletes"`, applied after the query's own conditions, which are grouped
first: `where(a).orWhere(b)` stays `(a or b) and deleted_at is null`.

### Events and observers

`retrieved`, `creating`, `created`, `updating`, `updated`, `saving`, `saved`, `deleting`, `deleted`, `restoring`,
`restored`, `forceDeleting` and `forceDeleted`, registered in a static block or from outside the class:

```ts
class User extends Model {
  static {
    this.saving((user) => {
      if (!user.email.includes("@")) return false;   // an "-ing" event cancels the write by returning false
    });
  }
}

User.observe({
  afterCommit: true,                                 // after the surrounding transaction commits; never on rollback
  created: (user) => mailer.send(welcome(user)),
});
User.observe(UserObserver);                          // a class with a method per event, and static afterCommit
User.created(listener, { afterCommit: true });
```

Listeners are awaited in order, in the same async context, so their queries join the transaction the write runs in
and roll back with it. With `afterCommit`, the events after a write wait for the commit (a savepoint that rolls back
drops them); the "-ing" events still run first, since they can change or cancel the write. Outside a transaction they
run straight away. Save fires `saving`, then `creating`/`created` or `updating`/`updated`, then `saved`; a save
without changes fires only `saving` and `saved`. A model hears the listeners of the classes it extends;
`flushEventListeners()` removes a class's own.

### Scopes

```ts
class User extends Model {
  static active = scope<User>((query) => query.where("isAdmin", true));
  static ofTeam = scope<User, [number]>((query, teamId) => query.where("teamId", teamId));
  static globalScopes = { real: (query: ModelQuery<User>) => query.whereNotNull("email") };
}

await User.query().apply(User.active).apply(User.ofTeam, 7).get();
await User.withoutGlobalScope("real").get();      // or withoutGlobalScopes()
User.addGlobalScope("recent", (query) => query.where("createdAt", ">", lastYear));
```

A scope returns the query it was given, like every callback here. Inside a class body the query's type cannot come
from the class, so `scope<User>(…)` names it; without it, column names are not checked.

### Serialization

`toJSON()`, which `JSON.stringify` calls, returns the attributes without `hidden` ones, only the `visible` ones when
that is set, plus the getters named in `appends` and any loaded relations.

### Strict mode

On by default, per model class (`static strict = false` turns it off, `Model.strict = false` for every model). It turns
Eloquent's silent pitfalls into errors: `fill()` with a key that `fillable` would drop throws `MassAssignmentError`,
and reading a relation that was not loaded throws `RelationNotLoadedError`, since a property read cannot run a query.
Relations and eager loading come next; `getRelation`, `setRelation` and `relationLoaded` already hold them, apart from
the attributes.

### Model types

Column names and value types come from the `declare`d fields: `where("nmae", …)`, `where("isAdmin", "yes")`,
`orderBy("save")` and `create({ nmae })` do not compile, while a qualified `"table.column"` is accepted unchecked for
joins. The fields are one mapped type per model, which keeps checking fast: 200 models with 15 fields and 1,400 query
expressions check in about half a second with TypeScript 7. `select()` does not narrow the result type, and a getter
counts as a field.
