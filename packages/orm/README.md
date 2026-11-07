# @tenora/orm

The database layer of Tenora 1.0: connections, a query builder in the style of Laravel's, and transactions that queries
join on their own. It is being built on the `next` branch; see [the plan](../../docs/orm/plan.md). Models and tenancy
come in later phases.

Status: every database Tenora supports works and is tested: Postgres (`pg`), MySQL (`mysql2`), MariaDB (`mariadb`, or
`mysql2` with `dialect: "mariadb"`), SQLite (`better-sqlite3`) and SQL Server (`tedious`, with `client: "mssql"`).
`forUpdate()` is not available on SQL Server yet.

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

```ts
const id = await db.table("accounts").insertGetId({ name: "ada", balance: 10 });
const rich = await db.table("accounts").where("balance", ">", 100).orderBy("name").limit(20);
await db.table("accounts").where("id", id).increment("balance", 5);
await db.raw(sql`select * from ${sql.ref("accounts")} where lower(name) = ${name}`);
```

Every method returns a new builder, so a base query can be reused. `toSql()` shows the SQL and parameters.

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
