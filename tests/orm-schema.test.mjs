import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import knex from "knex";
import { createConnection, QueryError, sql } from "../packages/orm/dist/index.js";
import { loadEngines } from "./support/engines.mjs";

// Tenora connections that only compile (nothing connects until a query runs), and the Knex 3.3 clients 0.x used.
const COMPILE = {
  postgres: { tenora: { client: "pg", connection: {} }, knex: { client: "pg" } },
  mysql: { tenora: { client: "mysql2", connection: {} }, knex: { client: "mysql2" } },
  mariadb: { tenora: { client: "mysql2", dialect: "mariadb", connection: {} }, knex: { client: "mariadb" } },
  sqlite: {
    tenora: { client: "better-sqlite3", connection: { filename: ":memory:" } },
    knex: { client: "better-sqlite3", useNullAsDefault: true },
  },
  mssql: { tenora: { client: "pg", dialect: "mssql", connection: {} }, knex: { client: "mssql" } },
};

const compilers = Object.fromEntries(
  Object.entries(COMPILE).map(([dialect, config]) => [
    dialect,
    { db: createConnection(config.tenora), knex: knex(config.knex) },
  ])
);

after(async () => {
  for (const { db, knex: client } of Object.values(compilers)) {
    await db.destroy();
    await client.destroy();
  }
});

const normalize = (statements) => statements.map(({ sql: text, bindings }) => ({ sql: text, bindings: [...(bindings ?? [])] }));

/**
 * Runs the same migration code through Knex's schema builder and Tenora's Knex-compatible one, on every dialect, and
 * expects the same statements. `raw` is `knex.raw` for Knex and the `sql` tag for Tenora.
 */
const sameAsKnex = (build) => {
  for (const [dialect, { db, knex: client }] of Object.entries(compilers)) {
    const expected = normalize(build(client.schema, (text) => client.raw(text), dialect).toSQL());
    const actual = normalize(build(db.schema.knex, (text) => sql`${sql.raw(text)}`, dialect).toSQL());
    assert.deepEqual(actual, expected, dialect);
  }
};

describe("the Knex-compatible schema builder writes what Knex 3.3 writes", () => {
  it("creates a table with every column type", () => {
    sameAsKnex((schema) =>
      schema.createTable("everything", (t) => {
        t.increments("id");
        t.integer("count");
        t.integer("sized", 7);
        t.bigInteger("big");
        t.bigint("big2");
        t.smallint("small");
        t.tinyint("tiny");
        t.tinyint("tiny2", 2);
        t.string("name");
        t.string("code", 20);
        t.text("body");
        t.text("medium", "mediumtext");
        t.boolean("active");
        t.date("born");
        t.datetime("seen");
        t.datetime("seen_plain", { useTz: false, precision: 3 });
        t.timestamp("stamped");
        t.timestamp("stamped_tz", { useTz: true });
        t.time("at");
        t.decimal("total");
        t.decimal("money", 12, 4);
        t.float("ratio");
        t.float("ratio2", 6, 3);
        t.double("precise");
        t.json("meta");
        t.jsonb("metab");
        t.uuid("uid");
        t.enu("status", ["draft", "published"]);
        t.enum("kind", ["a", "b"]);
        t.binary("blob");
        t.binary("short", 16);
        t.specificType("tags", "varchar(40)");
      })
    );
  });

  it("writes modifiers in each dialect's order", () => {
    sameAsKnex((schema, raw) =>
      schema.createTable("orders", (t) => {
        t.increments("id").primary();
        t.integer("customer_id").unsigned().notNullable().references("id").inTable("customers").onDelete("CASCADE");
        t.decimal("total", 12, 2).notNullable().defaultTo(0);
        t.string("note").nullable().defaultTo("it's \\ here");
        t.boolean("paid").defaultTo(false);
        t.boolean("open").notNullable().defaultTo(true);
        t.string("state").defaultTo(null);
        t.json("meta").defaultTo({ a: 1 });
        t.text("body").defaultTo("x");
        t.timestamp("placed_at").defaultTo(raw("CURRENT_TIMESTAMP"));
        t.integer("rank").notNull().unsigned();
      })
    );
  });

  it("writes timestamps() in its four forms", () => {
    sameAsKnex((schema) =>
      schema
        .createTable("a", (t) => t.timestamps())
        .createTable("b", (t) => t.timestamps(true, true))
        .createTable("c", (t) => t.timestamps(false, true))
        .createTable("d", (t) => t.timestamps({ useTimestamps: true, useCamelCase: true }))
    );
  });

  it("names and writes keys and indexes", () => {
    sameAsKnex((schema) =>
      schema.createTable("users", (t) => {
        t.bigIncrements("id");
        t.string("email").unique();
        t.string("handle").unique("users_handle_key");
        t.string("first");
        t.string("last");
        t.integer("team_id").references("teams.id").onDelete("SET NULL").onUpdate("CASCADE");
        t.integer("org_id");
        t.integer("rank").index();
        t.integer("score").index("users_score_idx");
        t.unique(["first", "last"]);
        t.index(["last", "first"], "users_names_index");
        t.foreign("org_id").references("id").inTable("orgs").withKeyName("users_org_fk");
      })
    );
  });

  it("writes composite primary keys, including next to an increments column", () => {
    sameAsKnex((schema) =>
      schema
        .createTable("memberships", (t) => {
          t.integer("user_id").notNullable();
          t.integer("team_id").notNullable();
          t.primary(["user_id", "team_id"]);
        })
        .createTable("named", (t) => {
          t.string("code");
          t.primary(["code"], "named_code_pk");
        })
        .createTable("lines", (t) => {
          t.increments("id");
          t.integer("position");
          t.primary(["id", "position"]);
        })
        .createTable("codes", (t) => {
          t.string("code", 10).primary();
          t.string("label");
        })
    );
  });

  it("adds columns, keys and indexes to an existing table", () => {
    sameAsKnex((schema) =>
      schema.alterTable("users", (t) => {
        t.string("email", 100).notNullable().defaultTo("a");
        t.integer("n");
        t.index(["email", "n"]);
        t.unique("email");
        t.foreign("team_id").references("teams.id").onDelete("SET NULL");
      })
    );
  });

  it("changes columns with alter()", () => {
    sameAsKnex((schema) =>
      schema
        .alterTable("users", (t) => {
          t.string("email", 100).notNullable().defaultTo("a").alter();
          t.integer("age").alter();
        })
        .table("posts", (t) => {
          t.text("body").nullable().alter({ alterNullable: false });
          t.enu("state", ["a", "b", "c"]).alter({ alterType: false });
        })
    );
  });

  it("drops and renames columns, keys and indexes", () => {
    sameAsKnex((schema) =>
      schema.alterTable("users", (t) => {
        t.dropColumn("email");
        t.dropColumns("a", "b");
        t.dropColumn(["c", "d"]);
        t.renameColumn("first", "given");
        t.dropForeign("team_id");
        t.dropForeign(["org_id"], "users_org_fk");
        t.dropIndex(["a", "b"]);
        t.dropIndex([], "users_names_index");
        t.dropUnique("email");
        t.dropUnique(["first", "last"], "users_names_unique");
        t.dropTimestamps();
      })
    );
  });

  it("adds and drops primary keys on an existing table", () => {
    sameAsKnex((schema) =>
      schema
        .alterTable("tags", (t) => {
          t.primary(["name"]);
        })
        .alterTable("labels", (t) => {
          t.dropPrimary();
          t.dropPrimary("labels_custom_pk");
        })
    );
  });

  it("drops, renames and creates tables", () => {
    sameAsKnex((schema, raw) =>
      schema
        .dropTable("a")
        .dropTableIfExists("b")
        .renameTable("c", "d")
        .createTableIfNotExists("e", (t) => {
          t.increments();
          t.string("name");
        })
        .raw("update e set name = ? where name is null", ["unnamed"])
    );
  });

  it("uses the MySQL charset, collation and engine of the 0.x connection", () => {
    for (const dialect of ["mysql", "mariadb"]) {
      const client = knex({ client: COMPILE[dialect].knex.client, connection: { charset: "utf8mb4", collate: "utf8mb4_unicode_ci" } });
      const build = (schema) =>
        schema.createTable("t", (t) => {
          t.increments();
          t.engine("InnoDB");
        });
      const expected = normalize(build(client.schema).toSQL());
      const actual = normalize(
        build(compilers[dialect].db.schema.knex.withOptions({ charset: "utf8mb4", collate: "utf8mb4_unicode_ci" })).toSQL()
      );
      assert.deepEqual(actual, expected, dialect);
      void client.destroy();
    }
  });

  it("keeps separate calls on one builder apart, and chains like Knex", () => {
    const schema = compilers.postgres.db.schema.knex;
    schema.createTable("a", (t) => t.increments());
    const b = schema.createTable("b", (t) => t.increments());
    assert.deepEqual(
      b.toSQL().map((statement) => statement.sql),
      ['create table "b" ("id" serial primary key)']
    );
  });

  it("refuses alter-only methods in createTable()", () => {
    assert.throws(
      () => compilers.postgres.db.schema.knex.createTable("t", (t) => t.dropColumn("x")).toSQL(),
      /only works inside alterTable/
    );
  });
});

describe("compiling the Laravel-style schema builder", () => {
  const compile = (dialect, change) => change(compilers[dialect].db.schema).toSql().map((statement) => statement.sql);

  const users = (schema) =>
    schema.create("users", (t) => {
      t.id();
      t.string("email").unique();
      t.foreignId("team_id").constrained().cascadeOnDelete();
      t.boolean("active").default(true);
      t.enum("role", ["admin", "member"]).default("member");
      t.timestamps();
    });

  it("creates a table on each database", () => {
    assert.deepEqual(compile("postgres", users), [
      'create table "users" ("id" bigserial not null primary key, "email" varchar(255) not null, "team_id" bigint not null, "active" boolean default true not null, "role" varchar(255) default \'member\' not null check ("role" in (\'admin\', \'member\')), "created_at" timestamp(0) without time zone null, "updated_at" timestamp(0) without time zone null, constraint "users_team_id_foreign" foreign key ("team_id") references "teams" ("id") on delete cascade)',
      'alter table "users" add constraint "users_email_unique" unique ("email")',
    ]);
    assert.deepEqual(compile("mysql", users), [
      "create table `users` (`id` bigint unsigned not null primary key auto_increment, `email` varchar(255) not null, `team_id` bigint unsigned not null, `active` tinyint(1) default 1 not null, `role` enum('admin', 'member') default 'member' not null, `created_at` timestamp null, `updated_at` timestamp null, constraint `users_team_id_foreign` foreign key (`team_id`) references `teams` (`id`) on delete cascade)",
      "alter table `users` add constraint `users_email_unique` unique (`email`)",
    ]);
    assert.deepEqual(compile("sqlite", users), [
      'create table "users" ("id" integer not null primary key autoincrement, "email" varchar not null, "team_id" integer not null, "active" tinyint(1) default 1 not null, "role" varchar default \'member\' not null check ("role" in (\'admin\', \'member\')), "created_at" datetime null, "updated_at" datetime null, constraint "users_team_id_foreign" foreign key ("team_id") references "teams" ("id") on delete cascade)',
      'create unique index "users_email_unique" on "users" ("email")',
    ]);
    assert.deepEqual(compile("mssql", users), [
      'create table "users" ("id" bigint identity not null primary key, "email" nvarchar(255) not null, "team_id" bigint not null, "active" bit constraint "users_active_default" default 1 not null, "role" nvarchar(255) constraint "users_role_default" default N\'member\' not null check ("role" in (N\'admin\', N\'member\')), "created_at" datetime2(0) null, "updated_at" datetime2(0) null, constraint "users_team_id_foreign" foreign key ("team_id") references "teams" ("id") on delete cascade)',
      'create unique index "users_email_unique" on "users" ("email")',
    ]);
  });

  it("changes a table on each database", () => {
    const change = (schema) =>
      schema.table("users", (t) => {
        t.string("nickname", 50).nullable().index();
        t.string("email", 320).change();
        t.renameColumn("role", "kind");
        t.dropColumn("active");
        t.dropUnique(["email"]);
      });
    assert.deepEqual(compile("postgres", change), [
      'alter table "users" add column "nickname" varchar(50) null',
      'alter table "users" alter column "email" type varchar(320) using "email"::varchar(320), alter column "email" set not null, alter column "email" drop default',
      'alter table "users" rename column "role" to "kind"',
      'alter table "users" drop column "active"',
      'alter table "users" drop constraint "users_email_unique"',
      'create index "users_nickname_index" on "users" ("nickname")',
    ]);
    assert.deepEqual(compile("mysql", change), [
      "alter table `users` add column `nickname` varchar(50) null",
      "alter table `users` modify column `email` varchar(320) not null",
      "alter table `users` rename column `role` to `kind`",
      "alter table `users` drop column `active`",
      "drop index `users_email_unique` on `users`",
      "create index `users_nickname_index` on `users` (`nickname`)",
    ]);
    assert.deepEqual(compile("sqlite", change), [
      'alter table "users" add column "nickname" varchar null',
      '-- rebuild "users": change "email" (SQLite cannot alter it in place)',
      'alter table "users" rename column "role" to "kind"',
      '-- drop "active" from "users" (rebuilds the table if a key or index uses them)',
      'drop index "users_email_unique"',
      'create index "users_nickname_index" on "users" ("nickname")',
    ]);
    const mssql = compile("mssql", change);
    assert.equal(mssql[0], 'alter table "users" add "nickname" nvarchar(50) null');
    assert.match(mssql[1], /^declare @sql nvarchar\(max\).*N'email'/);
    assert.equal(mssql[2], 'alter table "users" alter column "email" nvarchar(320) not null');
    assert.equal(mssql[3], "exec sp_rename N'users.role', N'kind', N'COLUMN'");
    assert.match(mssql[4], /^declare @sql nvarchar\(max\).*N'active'/);
    assert.equal(mssql[5], 'alter table "users" drop column "active"');
    assert.equal(mssql[6], 'drop index "users_email_unique" on "users"');
  });

  it("drops and renames tables", () => {
    const statements = (dialect) => [
      ...compilers[dialect].db.schema.drop("a").toSql(),
      ...compilers[dialect].db.schema.dropIfExists("b").toSql(),
      ...compilers[dialect].db.schema.rename("c", "d").toSql(),
    ].map((statement) => statement.sql);
    assert.deepEqual(statements("postgres"), ['drop table "a"', 'drop table if exists "b"', 'alter table "c" rename to "d"']);
    assert.deepEqual(statements("mssql"), ['drop table "a"', 'drop table if exists "b"', "exec sp_rename N'c', N'd'"]);
  });

  it("refuses what cannot work", () => {
    const { schema } = compilers.postgres.db;
    assert.throws(() => schema.create("t", (t) => t.dropColumn("x")), /only works in schema.table/);
    assert.throws(
      () =>
        schema
          .create("t", (t) => {
            t.id();
            t.primary(["id"]);
          })
          .toSql(),
      /auto-increment primary key/
    );
    assert.throws(() => schema.create("t", async (t) => t.id()), /must not be async/);
    assert.throws(() => schema.table("t", (t) => t.foreign("x").references("id")).toSql(), /needs on\(table\)/);
  });
});
