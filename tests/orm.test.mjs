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
    });
    assert.throws(() => db.mssql.table("jobs").forUpdate().toSql(), /not supported on SQL Server/);
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
});

const DDL = {
  postgres:
    "create table accounts (id serial primary key, name varchar(100) not null unique, balance integer not null default 0)",
  mysql:
    "create table accounts (id int auto_increment primary key, name varchar(100) not null unique, balance int not null default 0) engine=InnoDB",
  sqlite:
    "create table accounts (id integer primary key autoincrement, name varchar(100) not null unique, balance integer not null default 0)",
};

const ORM_CLIENT = {
  postgres: { client: "pg" },
  mysql: { client: "mysql2" },
  // No mariadb driver yet; MariaDB servers are reached through mysql2 with the MariaDB dialect.
  mariadb: { client: "mysql2", dialect: "mariadb" },
};

const NOT_YET = {
  sqlite3: "the sqlite3 driver is dropped in 1.0",
  mssql: "the SQL Server driver is not implemented yet",
};

describe("ORM against a real database", () => {
  for (const engine of loadEngines()) {
    const skip = engine.skip || NOT_YET[engine.id] || false;
    describe(engine.label, { skip }, () => {
      const isSqlite = engine.id === "better-sqlite3";
      const dialect = isSqlite ? "sqlite" : engine.id === "postgres" ? "postgres" : "mysql";
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
          const { host, port, user, password } = engine.server;
          db = createConnection({
            ...ORM_CLIENT[engine.id],
            connection: { host, port, user, password, database },
            pool: { max: 5, acquireTimeoutMillis: 5_000 },
          });
        }
        await db.raw(sql`${sql.raw(DDL[dialect])}`);
      });

      afterEach(async () => {
        await db.table("accounts").delete();
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
            assert.equal((await observer("accounts").where({ name: "ada" })).length, 0);
          });
          assert.equal((await observer("accounts").where({ name: "ada" })).length, 1);
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
            : {
                ...ORM_CLIENT[engine.id],
                connection: { host: engine.server.host, port: engine.server.port, user: engine.server.user, password: engine.server.password, database },
              };
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
