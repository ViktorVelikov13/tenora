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
a model never falls back to another database. Inside `db.transaction()`, model queries, saves and the events they
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
`satisfies Casts<User>` checks the casts against the declared fields, typos included.

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
