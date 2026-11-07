import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import knex from "knex";
import {
  afterCommit,
  ConcurrentTransactionError,
  createConnection,
  QueryError,
  sql,
  TransactionAbortedError,
  TransactionClosedError,
  withoutTransaction,
} from "../packages/orm/dist/index.js";
import { loadEngines } from "./support/engines.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

/** Resolves once `count` callers are waiting, so two transactions can be lined up against each other. */
const barrier = (count) => {
  let release;
  const all = new Promise((resolve) => (release = resolve));
  let arrived = 0;
  return () => {
    arrived += 1;
    if (arrived === count) release();
    return all;
  };
};

describe("compiling queries", () => {
  const dialects = {
    postgres: { client: "pg", connection: {} },
    mysql: { client: "mysql2", connection: {} },
    mariadb: { client: "mysql2", dialect: "mariadb", connection: {} },
    sqlite: { client: "better-sqlite3", connection: { filename: ":memory:" } },
    mssql: { client: "pg", dialect: "mssql", connection: {} },
  };
  const db = Object.fromEntries(
    Object.entries(dialects).map(([name, config]) => [name, createConnection(config)])
  );

  const expectSql = (build, expected) => {
    for (const [dialect, text] of Object.entries(expected)) {
      assert.equal(build(db[dialect]).toSql().sql, text, dialect);
    }
  };

  it("reads a flat where list with SQL precedence, as Eloquent emits it", () => {
    const query = db.postgres
      .table("users")
      .where("active", true)
      .where((q) => q.where("role", "admin").orWhere("role", "owner"))
      .orWhere("vip", true);
    assert.deepEqual(query.toSql(), {
      sql: 'select * from "users" where (("active" = $1 and ("role" = $2 or "role" = $3)) or "vip" = $4)',
      parameters: [true, "admin", "owner", true],
    });
  });

  it("quotes and binds for every dialect", () => {
    expectSql((d) => d.table("users").where("email", "a@b.c").select("id", "email"), {
      postgres: 'select "id", "email" from "users" where "email" = $1',
      mysql: "select `id`, `email` from `users` where `email` = ?",
      mariadb: "select `id`, `email` from `users` where `email` = ?",
      sqlite: 'select "id", "email" from "users" where "email" = ?',
      mssql: 'select "id", "email" from "users" where "email" = @1',
    });
  });

  it("pages with each dialect's syntax", () => {
    expectSql((d) => d.table("users").orderBy("id").limit(10).offset(20), {
      postgres: 'select * from "users" order by "id" asc limit $1 offset $2',
      mysql: "select * from `users` order by `id` asc limit ? offset ?",
      sqlite: 'select * from "users" order by "id" asc limit ? offset ?',
      mssql: 'select * from "users" order by "id" asc offset @1 rows fetch next @2 rows only',
    });
    expectSql((d) => d.table("users").limit(3), {
      postgres: 'select * from "users" limit $1',
      mssql: 'select top(3) * from "users"',
    });
    // An offset needs a LIMIT on MySQL and SQLite, and an ORDER BY on SQL Server.
    expectSql((d) => d.table("users").offset(5), {
      postgres: 'select * from "users" offset $1',
      mysql: "select * from `users` limit 18446744073709551615 offset ?",
      sqlite: 'select * from "users" limit -1 offset ?',
      mssql: 'select * from "users" order by (select null) offset @1 rows',
    });
  });

  /** Runs a write against a connection whose execute() records the SQL instead of sending it. */
  const capture = async (connection, run) => {
    const statements = [];
    connection.execute = (compiled) => {
      statements.push(compiled.sql);
      return Promise.resolve({ rows: [{ id: 1 }], affectedRows: 1, insertId: 1 });
    };
    try {
      await run(connection);
    } finally {
      delete connection.execute;
    }
    return statements;
  };

  it("returns inserted ids with each dialect's syntax", async () => {
    const expected = {
      postgres: 'insert into "accounts" ("name") values ($1) returning "id"',
      mariadb: "insert into `accounts` (`name`) values (?) returning `id`",
      sqlite: 'insert into "accounts" ("name") values (?) returning "id"',
      mssql: 'insert into "accounts" ("name") output "inserted"."id" values (@1)',
      // MySQL has no RETURNING; the driver reports the insert id instead.
      mysql: "insert into `accounts` (`name`) values (?)",
    };
    for (const [dialect, text] of Object.entries(expected)) {
      const statements = await capture(db[dialect], (c) => c.table("accounts").insertGetId({ name: "ada" }));
      assert.deepEqual(statements, [text], dialect);
    }
  });

  it("compiles increments and deletes for every dialect", async () => {
    const expected = {
      postgres: ['update "accounts" set "balance" = "balance" + $1 where "id" = $2', 'delete from "accounts" where "id" = $1'],
      mysql: ["update `accounts` set `balance` = `balance` + ? where `id` = ?", "delete from `accounts` where `id` = ?"],
      sqlite: ['update "accounts" set "balance" = "balance" + ? where "id" = ?', 'delete from "accounts" where "id" = ?'],
      mssql: ['update "accounts" set "balance" = "balance" + @1 where "id" = @2', 'delete from "accounts" where "id" = @1'],
    };
    for (const [dialect, texts] of Object.entries(expected)) {
      const statements = await capture(db[dialect], async (c) => {
        await c.table("accounts").where("id", 7).increment("balance");
        await c.table("accounts").where("id", 7).delete();
      });
      assert.deepEqual(statements, texts, dialect);
    }
  });

  it("turns empty IN lists into conditions that are valid SQL", () => {
    expectSql((d) => d.table("users").whereIn("id", []).whereNotIn("team_id", []), {
      postgres: 'select * from "users" where (1 = 0 and 1 = 1)',
    });
  });

  it("treats where(column, null) as IS NULL", () => {
    expectSql((d) => d.table("users").where("deleted_at", null).where("archived_at", "!=", null), {
      postgres: 'select * from "users" where ("deleted_at" is null and "archived_at" is not null)',
    });
  });

  it("locks rows except on SQLite, where the transaction already locks the database", () => {
    expectSql((d) => d.table("jobs").skipLocked().limit(1), {
      postgres: 'select * from "jobs" limit $1 for update skip locked',
      mysql: "select * from `jobs` limit ? for update skip locked",
      sqlite: 'select * from "jobs" limit ?',
      mssql: 'select top(1) * from "jobs" with (updlock, rowlock, readpast)',
    });
  });

  it("binds raw fragments and quotes their identifiers", () => {
    const query = db.mysql.table("users").whereRaw(sql`lower(${sql.ref("users.email")}) = ${"a@b.c"}`);
    assert.deepEqual(query.toSql(), {
      sql: "select * from `users` where lower(`users`.`email`) = ?",
      parameters: ["a@b.c"],
    });
  });

  it("rejects operators that are not comparisons", () => {
    assert.throws(() => db.postgres.table("users").where("id", "= 1 or 1 =", 1), /unknown operator/);
  });

  it("refuses update and delete with limit or order, which they would silently ignore", async () => {
    await assert.rejects(db.postgres.table("users").limit(1).delete(), /ignores limit/);
  });

  it("binds join values as parameters and compares join columns as columns", () => {
    const query = db.postgres
      .table("orders as o")
      .join("customers as c", "c.id", "o.customer_id")
      .leftJoin("notes", (j) => j.on("notes.order_id", "o.id").where("notes.kind", "public"))
      .where("o.total", ">", 10);
    assert.deepEqual(query.toSql(), {
      sql: 'select * from "orders" as "o" inner join "customers" as "c" on "c"."id" = "o"."customer_id" left join "notes" on ("notes"."order_id" = "o"."id" and "notes"."kind" = $1) where "o"."total" > $2',
      parameters: ["public", 10],
    });
  });

  it("locks with each dialect's syntax", () => {
    expectSql((d) => d.table("jobs as j").forUpdate().skipLocked(), {
      postgres: 'select * from "jobs" as "j" for update skip locked',
      mysql: "select * from `jobs` as `j` for update skip locked",
      sqlite: 'select * from "jobs" as "j"',
      mssql: 'select * from "jobs" as "j" with (updlock, rowlock, readpast)',
    });
    expectSql((d) => d.table("jobs").sharedLock(), {
      postgres: 'select * from "jobs" for share',
      mysql: "select * from `jobs` for share",
      mariadb: "select * from `jobs` lock in share mode",
      mssql: 'select * from "jobs" with (holdlock, rowlock)',
    });
  });

  it("orders and limits a union as a whole", () => {
    expectSql((d) => d.table("a").select("id").union(d.table("b").select("id")).orderBy("id").limit(5), {
      postgres: 'select "id" from "a" union select "id" from "b" order by "id" asc limit $1',
      mssql: 'select "id" from "a" union select "id" from "b" order by "id" asc offset @1 rows fetch next @2 rows only',
    });
    assert.throws(
      () => db.postgres.table("a").union(db.postgres.table("b").orderBy("id")).toSql(),
      /cannot have orderBy, limit or offset/
    );
  });

  it("counts a grouped query's rows, not its first group", async () => {
    const statements = await capture(db.postgres, (c) => c.table("orders").select("customer_id").groupBy("customer_id").count());
    assert.deepEqual(statements, [
      'select count(*) as "aggregate" from (select "customer_id" from "orders" group by "customer_id") as "tenora_count"',
    ]);
    await assert.rejects(db.postgres.table("orders").groupBy("customer_id").sum("total"), /selectRaw\(\) and groupBy\(\)/);
  });

  it("upserts with each dialect's syntax", async () => {
    const expected = {
      postgres: 'insert into "accounts" ("email", "name") values ($1, $2) on conflict ("email") do update set "name" = "excluded"."name"',
      sqlite: 'insert into "accounts" ("email", "name") values (?, ?) on conflict ("email") do update set "name" = "excluded"."name"',
      mysql: "insert into `accounts` (`email`, `name`) values (?, ?) as `tenora_new` on duplicate key update `name` = `tenora_new`.`name`",
      mariadb: "insert into `accounts` (`email`, `name`) values (?, ?) on duplicate key update `name` = values(`name`)",
      mssql: 'merge into "accounts" with (holdlock) as "tenora_target" using (values (@1, @2)) as "tenora_source" ("email", "name") on "tenora_target"."email" = "tenora_source"."email" when matched then update set "name" = "tenora_source"."name" when not matched then insert ("email", "name") values ("tenora_source"."email", "tenora_source"."name");',
    };
    for (const [dialect, text] of Object.entries(expected)) {
      const statements = await capture(db[dialect], (c) => c.table("accounts").upsert({ email: "a@b.c", name: "Ada" }, "email"));
      assert.deepEqual(statements, [text], dialect);
    }
  });

  it("refuses a subquery from another connection, which would be another database", () => {
    const other = createConnection({ client: "pg", connection: {} });
    assert.throws(() => db.postgres.table("users").whereIn("id", other.table("orders").select("user_id")), /same connection/);
  });

  it("refuses writes on joined, grouped or subquery sources", async () => {
    await assert.rejects(db.postgres.table("a").join("b", "a.id", "b.a_id").update({ x: 1 }), /works on one table/);
    await assert.rejects(db.postgres.fromSub(db.postgres.table("a"), "t").delete(), /needs a table/);
  });

  it("applies when() only for truthy values, and passes the value on", () => {
    const search = (term) => db.postgres.table("users").when(term, (q, t) => q.where("name", "like", `${t}%`)).toSql();
    assert.equal(search("ad").sql, 'select * from "users" where "name" like $1');
    assert.deepEqual(search("ad").parameters, ["ad%"]);
    assert.equal(search("").sql, 'select * from "users"');
  });
});

const DDL = {
  postgres: [
    "create table accounts (id serial primary key, name varchar(100) not null unique, balance integer not null default 0)",
    "create table customers (id serial primary key, name varchar(100) not null, email varchar(100) not null unique)",
    "create table orders (id serial primary key, customer_id integer not null, total integer not null, status varchar(20) not null)",
  ],
  mysql: [
    "create table accounts (id int auto_increment primary key, name varchar(100) not null unique, balance int not null default 0) engine=InnoDB",
    "create table customers (id int auto_increment primary key, name varchar(100) not null, email varchar(100) not null unique) engine=InnoDB",
    "create table orders (id int auto_increment primary key, customer_id int not null, total int not null, status varchar(20) not null) engine=InnoDB",
  ],
  sqlite: [
    "create table accounts (id integer primary key autoincrement, name varchar(100) not null unique, balance integer not null default 0)",
    "create table customers (id integer primary key autoincrement, name varchar(100) not null, email varchar(100) not null unique)",
    "create table orders (id integer primary key autoincrement, customer_id integer not null, total integer not null, status varchar(20) not null)",
  ],
  mssql: [
    "create table accounts (id int identity(1,1) primary key, name nvarchar(100) not null unique, balance int not null default 0)",
    "create table customers (id int identity(1,1) primary key, name nvarchar(100) not null, email nvarchar(100) not null unique)",
    "create table orders (id int identity(1,1) primary key, customer_id int not null, total int not null, status nvarchar(20) not null)",
  ],
};
DDL.mariadb = DDL.mysql;

const DIALECT = { "better-sqlite3": "sqlite", postgres: "postgres", mysql: "mysql", mariadb: "mariadb", mssql: "mssql" };

const ORM_CLIENT = { postgres: "pg", mysql: "mysql2", mariadb: "mariadb", mssql: "mssql" };

const NOT_YET = {
  sqlite3: "the sqlite3 driver is dropped in 1.0",
};

/** The ORM's config for a test server, in the shape 0.x configs use. */
const serverConfig = (engine, database) => {
  const { host, port, user, password } = engine.server;
  return {
    client: ORM_CLIENT[engine.id],
    connection:
      engine.id === "mssql"
        ? { server: host, port, user, password, database, options: { encrypt: false, trustServerCertificate: true } }
        : { host, port, user, password, database },
  };
};

describe("ORM against a real database", () => {
  for (const engine of loadEngines()) {
    const skip = engine.skip || NOT_YET[engine.id] || false;
    describe(engine.label, { skip }, () => {
      const isSqlite = engine.id === "better-sqlite3";
      const dialect = DIALECT[engine.id];
      const database = `tenora_orm_${randomBytes(3).toString("hex")}`;
      const sqliteDir = isSqlite ? fs.mkdtempSync(path.join(os.tmpdir(), "tenora-orm-")) : undefined;
      let admin;
      let observer;
      let db;

      before(async () => {
        if (isSqlite) {
          db = createConnection({
            client: "better-sqlite3",
            connection: { filename: path.join(sqliteDir, `${database}.sqlite`) },
            pool: { acquireTimeoutMillis: 2_000 },
          });
        } else {
          admin = knex(engine.knexConfig(engine.adminDatabase));
          await engine.createDatabase(admin, database);
          observer = knex(engine.knexConfig(database));
          db = createConnection({ ...serverConfig(engine, database), pool: { max: 5, acquireTimeoutMillis: 5_000 } });
        }
        for (const statement of DDL[dialect]) await db.raw(sql`${sql.raw(statement)}`);
      });

      afterEach(async () => {
        for (const table of ["accounts", "orders", "customers"]) await db.table(table).delete();
      });

      after(async () => {
        await db?.destroy();
        await observer?.destroy();
        if (admin) {
          await engine.cleanup(admin, { databases: [database], users: [] });
          await admin.destroy();
        }
        if (sqliteDir) fs.rmSync(sqliteDir, { recursive: true, force: true });
      });

      const names = async () => (await db.table("accounts").orderBy("name").pluck("name"));

      // SQL Server's default READ COMMITTED makes a reader wait for the writer's lock; READPAST skips locked rows.
      const committedRows = (name) =>
        dialect === "mssql"
          ? observer.raw("select name from accounts with (readpast) where name = ?", [name])
          : observer("accounts").where({ name });

      describe("query builder", () => {
        it("inserts, reads, updates and deletes", async () => {
          const id = await db.table("accounts").insertGetId({ name: "ada", balance: 10 });
          assert.equal(await db.table("accounts").insert([{ name: "bob", balance: 5 }, { name: "cy", balance: 0 }]), 2);

          const ada = await db.table("accounts").where("id", id).first();
          assert.equal(ada.name, "ada");
          assert.equal(await db.table("accounts").where("balance", ">", 1).count(), 2);
          assert.deepEqual(await db.table("accounts").whereIn("name", ["bob", "cy"]).orderBy("name", "desc").pluck("name"), ["cy", "bob"]);
          assert.deepEqual(await db.table("accounts").orderBy("name").limit(1).offset(1).pluck("name"), ["bob"]);

          assert.equal(await db.table("accounts").where("name", "bob").update({ balance: 7 }), 1);
          assert.equal(await db.table("accounts").where("name", "ada").increment("balance", 5), 1);
          assert.deepEqual(await db.table("accounts").orderBy("name").pluck("balance"), [15, 7, 0]);

          assert.equal(await db.table("accounts").where("balance", 0).delete(), 1);
          assert.deepEqual(await names(), ["ada", "bob"]);
          assert.equal(await db.table("accounts").where("name", "nobody").exists(), false);
        });

        it("reports constraint violations with a driver-independent kind", async () => {
          await db.table("accounts").insert({ name: "ada" });
          const error = await db.table("accounts").insert({ name: "ada" }).catch((e) => e);
          assert.ok(error instanceof QueryError);
          assert.equal(error.kind, "unique_violation");
        });
      });

      describe("joins, subqueries, grouping and upserts", () => {
        // ada: 10 queued, 30 shipped; bob: 20 queued, 60 queued; cy: no orders.
        const seed = async () => {
          await db.table("customers").insert([
            { name: "ada", email: "ada@x" },
            { name: "bob", email: "bob@x" },
            { name: "cy", email: "cy@x" },
          ]);
          const id = Object.fromEntries((await db.table("customers").get()).map((row) => [row.name, row.id]));
          await db.table("orders").insert([
            { customer_id: id.ada, total: 10, status: "queued" },
            { customer_id: id.ada, total: 30, status: "shipped" },
            { customer_id: id.bob, total: 20, status: "queued" },
            { customer_id: id.bob, total: 60, status: "queued" },
          ]);
        };
        const pairs = (rows, ...keys) => rows.map((row) => keys.map((key) => (key === "name" ? row[key] : row[key] === null ? null : Number(row[key]))));

        it("joins tables, with extra conditions in a callback", async () => {
          await seed();
          const joined = await db
            .table("orders as o")
            .join("customers as c", "c.id", "o.customer_id")
            .select("c.name", "o.total")
            .orderBy("o.total")
            .get();
          assert.deepEqual(pairs(joined, "name", "total"), [["ada", 10], ["bob", 20], ["ada", 30], ["bob", 60]]);

          const queued = await db
            .table("customers as c")
            .leftJoin("orders as o", (j) => j.on("o.customer_id", "c.id").where("o.status", "queued"))
            .select("c.name", "o.total")
            .orderBy("c.name")
            .orderBy("o.total")
            .get();
          assert.deepEqual(pairs(queued, "name", "total"), [["ada", 10], ["bob", 20], ["bob", 60], ["cy", null]]);
        });

        it("filters with subqueries", async () => {
          await seed();
          const bigSpenders = db.table("orders").select("customer_id").where("total", ">", 25);
          assert.deepEqual(await db.table("customers").whereIn("id", bigSpenders).orderBy("name").pluck("name"), ["ada", "bob"]);

          const withoutOrders = db.table("customers").whereNotExists(
            db.table("orders").whereColumn("orders.customer_id", "customers.id")
          );
          assert.deepEqual(await withoutOrders.pluck("name"), ["cy"]);
        });

        it("selects, joins and queries subqueries", async () => {
          await seed();
          const counted = await db
            .table("customers")
            .select("name")
            .selectSub(db.table("orders").selectRaw(sql`count(*)`).whereColumn("orders.customer_id", "customers.id"), "orders_count")
            .orderBy("name")
            .get();
          assert.deepEqual(pairs(counted, "name", "orders_count"), [["ada", 2], ["bob", 2], ["cy", 0]]);

          const spent = db.table("orders").select("customer_id").selectRaw(sql`sum(${sql.ref("total")}) as spent`).groupBy("customer_id");
          const joined = await db.table("customers as c").joinSub(spent, "t", "t.customer_id", "c.id").select("c.name", "t.spent").orderBy("c.name").get();
          assert.deepEqual(pairs(joined, "name", "spent"), [["ada", 40], ["bob", 80]]);
          assert.equal(await db.fromSub(spent, "t").where("t.spent", ">", 50).count(), 1);
        });

        it("groups, and counts a grouped query's rows", async () => {
          await seed();
          const perCustomer = db.table("orders").select("customer_id").groupBy("customer_id");
          assert.equal(await perCustomer.count(), 2);
          const big = await db
            .table("orders")
            .select("customer_id")
            .selectRaw(sql`count(*) as orders`)
            .groupBy("customer_id")
            .havingRaw(sql`sum(${sql.ref("total")}) > ${50}`)
            .get();
          assert.equal(big.length, 1);
          assert.equal(Number(big[0].orders), 2);
        });

        it("aggregates as numbers, and min and max as stored", async () => {
          await seed();
          assert.equal(await db.table("orders").sum("total"), 120);
          assert.equal(await db.table("orders").avg("total"), 30);
          assert.equal(Number(await db.table("orders").min("total")), 10);
          assert.equal(Number(await db.table("orders").max("total")), 60);
          assert.equal(await db.table("orders").where("total", ">", 1000).sum("total"), null);
          assert.equal(await db.table("orders").where("status", "queued").count(), 3);
        });

        it("combines queries with union, ordered and limited as a whole", async () => {
          await seed();
          const queued = db.table("orders").select("total").where("status", "queued");
          const shipped = db.table("orders").select("total").where("status", "shipped");
          assert.deepEqual((await queued.unionAll(shipped).orderByDesc("total").limit(2).pluck("total")).map(Number), [60, 30]);
          assert.equal(await queued.union(shipped).count(), 4);
        });

        it("reads conveniently: when, between, pages, random order, find and value", async () => {
          await seed();
          const search = (term) => db.table("customers").when(term, (q, t) => q.where("name", "like", `${t}%`)).orderBy("name").pluck("name");
          assert.deepEqual(await search("b"), ["bob"]);
          assert.deepEqual(await search(undefined), ["ada", "bob", "cy"]);
          assert.deepEqual((await db.table("orders").whereBetween("total", [15, 35]).orderBy("total").pluck("total")).map(Number), [20, 30]);
          assert.deepEqual(await db.table("customers").orderBy("name").forPage(2, 2).pluck("name"), ["cy"]);
          assert.equal((await db.table("customers").inRandomOrder().pluck("name")).length, 3);
          const adaId = await db.table("customers").where("name", "ada").value("id");
          assert.equal((await db.table("customers").find(adaId)).email, "ada@x");
          assert.equal(await db.table("customers as c").where("c.email", "ada@x").value("c.name"), "ada");
        });

        it("upserts: inserts new rows, updates existing ones, or leaves them alone", async () => {
          await seed();
          await db.table("customers").upsert(
            [
              { email: "ada@x", name: "Ada L" },
              { email: "dee@x", name: "dee" },
            ],
            "email"
          );
          assert.deepEqual(await db.table("customers").orderBy("email").pluck("name"), ["Ada L", "bob", "cy", "dee"]);

          await db.table("customers").upsert({ email: "dee@x", name: "ignored" }, "email", []);
          assert.equal(await db.table("customers").where("email", "dee@x").value("name"), "dee");
        });

        it("locks rows in a transaction, with each dialect's syntax", async () => {
          await seed();
          const rows = await db.transaction(async () => [
            await db.table("orders as o").where("o.total", 10).forUpdate().get(),
            await db.table("orders").where("total", 20).sharedLock().get(),
          ]);
          assert.deepEqual(rows.map((found) => found.length), [1, 1]);
        });

        it(
          "skips rows another transaction locked",
          { skip: isSqlite && "SQLite has one connection, so there is no other transaction" },
          async () => {
            await seed();
            const lockedId = await db.table("orders").where("total", 10).value("id");
            const locked = deferred();
            const release = deferred();
            const holder = db.transaction(async () => {
              await db.table("orders").where("id", lockedId).forUpdate().get();
              locked.resolve();
              await release.promise;
            });
            await locked.promise;
            const free = await db.transaction(() =>
              db.table("orders").where("status", "queued").forUpdate().skipLocked().orderBy("total").pluck("total")
            );
            release.resolve();
            await holder;
            assert.deepEqual(free.map(Number), [20, 60]);
          }
        );
      });

      describe("transactions", () => {
        it("joins every query in the callback without passing a handle, and commits", async () => {
          const result = await db.transaction(async () => {
            await db.table("accounts").insert({ name: "ada", balance: 10 });
            await db.table("accounts").where("name", "ada").decrement("balance", 3);
            return db.table("accounts").where("name", "ada").first();
          });
          assert.equal(result.balance, 7);
          assert.deepEqual(await names(), ["ada"]);
        });

        it("rolls everything back when the callback throws", async () => {
          await assert.rejects(
            db.transaction(async () => {
              await db.table("accounts").insert({ name: "ada" });
              await db.table("accounts").insert({ name: "bob" });
              throw new Error("boom");
            }),
            /boom/
          );
          assert.deepEqual(await names(), []);
        });

        it("hides uncommitted writes from other connections", { skip: isSqlite && "SQLite has one connection" }, async () => {
          await db.transaction(async () => {
            await db.table("accounts").insert({ name: "ada" });
            assert.equal((await committedRows("ada")).length, 0);
          });
          assert.equal((await committedRows("ada")).length, 1);
        });

        it("keeps queries started together with Promise.all inside the transaction", async () => {
          const rows = Array.from({ length: 20 }, (_, i) => ({ name: `row${String(i).padStart(2, "0")}` }));
          await assert.rejects(
            db.transaction(async () => {
              await Promise.all(rows.map((row) => db.table("accounts").insert(row)));
              throw new Error("undo");
            }),
            /undo/
          );
          assert.deepEqual(await names(), []);

          await db.transaction(() => Promise.all(rows.map((row) => db.table("accounts").insert(row))));
          assert.equal(await db.table("accounts").count(), 20);
        });

        it("rejects a query that runs after its transaction ended, instead of running it outside", async () => {
          const committed = deferred();
          let late;
          await db.transaction(async () => {
            await db.table("accounts").insert({ name: "ada" });
            // Created here, so it carries the transaction's context, but it only runs once the transaction ended.
            late = committed.promise.then(() => db.table("accounts").insert({ name: "late" }));
            late.catch(() => {});
          });
          committed.resolve();
          await assert.rejects(late, TransactionClosedError);
          assert.deepEqual(await names(), ["ada"]);
        });

        it("rejects the queries still queued when a transaction rolls back", async () => {
          let queued;
          await assert.rejects(
            db.transaction(async () => {
              queued = Promise.allSettled(
                Array.from({ length: 5 }, (_, i) => db.table("accounts").insert({ name: `q${i}` }))
              );
              throw new Error("fail fast");
            }),
            /fail fast/
          );
          const settled = await queued;
          assert.ok(settled.some((s) => s.status === "rejected" && s.reason instanceof TransactionClosedError));
          assert.deepEqual(await names(), []);
        });

        it("runs afterCommit callbacks once, after the commit", async () => {
          const seen = [];
          await db.transaction(async () => {
            await db.table("accounts").insert({ name: "ada" });
            afterCommit(async () => seen.push(await db.table("accounts").count()));
            seen.push("before commit");
          });
          assert.deepEqual(seen, ["before commit", 1]);
        });

        it("drops afterCommit callbacks when the transaction rolls back", async () => {
          let ran = false;
          await assert.rejects(
            db.transaction(async () => {
              afterCommit(() => (ran = true));
              throw new Error("rollback");
            })
          );
          assert.equal(ran, false);
        });

        it("runs afterCommit straight away outside a transaction", async () => {
          let ran = false;
          await afterCommit(() => (ran = true));
          assert.equal(ran, true);
        });

        it("makes a nested transaction a savepoint whose failure keeps the outer work", async () => {
          const callbacks = [];
          await db.transaction(async () => {
            await db.table("accounts").insert({ name: "outer" });
            await assert.rejects(
              db.transaction(async () => {
                await db.table("accounts").insert({ name: "inner" });
                afterCommit(() => callbacks.push("inner, rolled back"));
                throw new Error("inner failed");
              }),
              /inner failed/
            );
            await db.transaction(async () => {
              await db.table("accounts").insert({ name: "kept" });
              afterCommit(() => callbacks.push("kept"));
            });
            assert.deepEqual(callbacks, [], "nested callbacks wait for the outermost commit");
          });
          assert.deepEqual(await names(), ["kept", "outer"]);
          assert.deepEqual(callbacks, ["kept"]);
        });

        it("rolls back committed nested work when the outer transaction fails", async () => {
          await assert.rejects(
            db.transaction(async () => {
              await db.transaction(() => db.table("accounts").insert({ name: "inner" }));
              throw new Error("outer failed");
            })
          );
          assert.deepEqual(await names(), []);
        });

        it("runs sibling nested transactions one after the other", async () => {
          await db.transaction(() =>
            Promise.all(
              ["a", "b", "c"].map((name) =>
                db.transaction(async () => {
                  await db.table("accounts").insert({ name });
                  await sleep(5);
                  await db.table("accounts").where("name", name).increment("balance");
                })
              )
            )
          );
          assert.deepEqual(await db.table("accounts").orderBy("name").pluck("balance"), [1, 1, 1]);
        });

        it("refuses an outer query while a nested transaction is open", async () => {
          await db.transaction(async () => {
            const inside = deferred();
            const proceed = deferred();
            const nested = db.transaction(async () => {
              // The callback only starts once its SAVEPOINT ran.
              inside.resolve();
              await proceed.promise;
              await db.table("accounts").insert({ name: "inner" });
            });
            await inside.promise;
            await assert.rejects(db.table("accounts").insert({ name: "outer" }), ConcurrentTransactionError);
            proceed.resolve();
            await nested;
          });
          assert.deepEqual(await names(), ["inner"]);
        });

        it(
          "keeps a write made with withoutTransaction when the transaction rolls back",
          { skip: isSqlite && "SQLite has one connection, held by the transaction" },
          async () => {
            await assert.rejects(
              db.transaction(async () => {
                await db.table("accounts").insert({ name: "rolled back" });
                await withoutTransaction(() => db.table("accounts").insert({ name: "audit" }));
                throw new Error("payment failed");
              })
            );
            assert.deepEqual(await names(), ["audit"]);
          }
        );

        it("gives up waiting for a free connection instead of hanging", async () => {
          const config = isSqlite
            ? { client: "better-sqlite3", connection: { filename: path.join(sqliteDir, `${database}.sqlite`) } }
            : serverConfig(engine, database);
          const tiny = createConnection({ ...config, pool: { max: 1, acquireTimeoutMillis: 300 } });
          try {
            // The transaction holds the only connection, so the query outside it can never get one.
            await assert.rejects(
              tiny.transaction(() => withoutTransaction(() => tiny.table("accounts").count())),
              /waited|timeout/i
            );
          } finally {
            await tiny.destroy();
          }
        });

        it(
          "runs at the chosen isolation level, and leaves the pooled connection at the default",
          { skip: !["postgres", "mssql"].includes(dialect) && "only checked where the current level can be read" },
          async () => {
            const level =
              dialect === "postgres"
                ? sql`select current_setting('transaction_isolation') as level`
                : sql`select transaction_isolation_level as level from sys.dm_exec_sessions where session_id = @@spid`;
            const [serializable, readCommitted] = dialect === "postgres" ? ["serializable", "read committed"] : [4, 2];
            // One connection, so the query after the transaction runs on the same session.
            const single = createConnection({ ...serverConfig(engine, database), pool: { max: 1 } });
            try {
              const inside = await single.transaction(() => single.raw(level), { isolation: "serializable" });
              assert.equal(inside[0].level, serializable);
              assert.equal((await single.raw(level))[0].level, readCommitted);
            } finally {
              await single.destroy();
            }
          }
        );

        it("supports an explicit transaction handle", async () => {
          const trx = await db.beginTransaction();
          await db.table("accounts").using(trx).insert({ name: "explicit" });
          await trx.run(() => db.table("accounts").insert({ name: "ambient" }));
          await trx.rollback();
          assert.deepEqual(await names(), []);

          const second = await db.beginTransaction();
          await db.table("accounts").using(second).insert({ name: "kept" });
          await second.commit();
          assert.deepEqual(await names(), ["kept"]);
          await assert.rejects(db.table("accounts").using(second).insert({ name: "late" }), TransactionClosedError);
        });

        it(
          "reports a COMMIT that Postgres turned into a rollback",
          { skip: dialect !== "postgres" && "only Postgres fails the whole transaction on an error" },
          async () => {
            await assert.rejects(
              db.transaction(async () => {
                await db.table("accounts").insert({ name: "ada" });
                await db.table("accounts").insert({ name: "ada" }).catch(() => {});
              }),
              TransactionAbortedError
            );
            assert.deepEqual(await names(), []);
          }
        );

        it(
          "retries the whole callback after a real deadlock",
          { skip: isSqlite && "SQLite has one connection, so two transactions cannot deadlock" },
          async () => {
            await db.table("accounts").insert([{ name: "a" }, { name: "b" }]);
            const gate = barrier(2);
            const runs = { first: 0, second: 0 };
            // Each locks one row, waits for the other, then wants the other's row: one of them is the victim.
            const transfer = (key, from, to) =>
              db.transaction(
                async () => {
                  runs[key] += 1;
                  await db.table("accounts").where("name", from).increment("balance");
                  if (runs[key] === 1) await gate();
                  await db.table("accounts").where("name", to).increment("balance");
                },
                { attempts: 3 }
              );
            await Promise.all([transfer("first", "a", "b"), transfer("second", "b", "a")]);
            assert.equal(runs.first + runs.second, 3, "exactly one transaction ran twice");
            assert.deepEqual(await db.table("accounts").orderBy("name").pluck("balance"), [2, 2]);
          }
        );
      });
    });
  }
});
