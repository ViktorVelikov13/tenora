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

  it("takes the MySQL charset and collation from the connection config, in both schema builders", () => {
    const connection = { charset: "utf8mb4", collate: "utf8mb4_unicode_ci" };
    for (const dialect of ["mysql", "mariadb"]) {
      const client = knex({ client: COMPILE[dialect].knex.client, connection });
      const db = createConnection({ ...COMPILE[dialect].tenora, connection });
      const build = (schema) => schema.createTable("t", (t) => t.increments());
      assert.deepEqual(normalize(build(db.schema.knex).toSQL()), normalize(build(client.schema).toSQL()), dialect);
      assert.match(
        db.schema.create("t", (t) => t.id()).toSql()[0].sql,
        / default character set utf8mb4 collate utf8mb4_unicode_ci$/,
        dialect
      );
      void client.destroy();
    }
    const postgres = createConnection({ client: "pg", connection });
    assert.doesNotMatch(postgres.schema.create("t", (t) => t.id()).toSql()[0].sql, /character set|collate/);
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

// Real databases -----------------------------------------------------------------------------------------------------

const DIALECT = { "better-sqlite3": "sqlite", postgres: "postgres", mysql: "mysql", mariadb: "mariadb", mssql: "mssql" };
const ORM_CLIENT = { postgres: "pg", mysql: "mysql2", mariadb: "mariadb", mssql: "mssql" };

const serverConfig = (engine, database) => {
  const { host, port, user, password } = engine.server;
  return {
    client: ORM_CLIENT[engine.id],
    connection:
      engine.id === "mssql"
        ? { server: host, port, user, password, database, options: { encrypt: false, trustServerCertificate: true } }
        : { host, port, user, password, database },
    pool: { max: 4, acquireTimeoutMillis: 5_000 },
  };
};

const rejects = async (promise, kind) => {
  const error = await Promise.resolve(promise).then(
    () => undefined,
    (e) => e
  );
  assert.ok(error, "expected the statement to fail");
  if (kind) {
    assert.ok(error instanceof QueryError, `expected a QueryError, got ${error}`);
    assert.equal(error.kind, kind);
  }
  return error;
};

/** The parts of the catalog the upgrade's schema proof compares: columns, indexes and keys. */
const CATALOG = {
  sqlite: async (db) => {
    const tables = await db.raw(sql`select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name`);
    const out = {};
    for (const { name } of tables) {
      out[name] = {
        columns: await db.raw(sql`select name, type, "notnull", dflt_value, pk from pragma_table_xinfo(${name})`),
        indexes: await db.raw(
          sql`select l.name as name, l."unique" as is_unique, l.origin as origin, group_concat(i.name) as columns from pragma_index_list(${name}) as l, pragma_index_info(l.name) as i group by l.name order by l.name`
        ),
        foreignKeys: await db.raw(
          sql`select "table", "from", "to", on_update, on_delete from pragma_foreign_key_list(${name}) order by "from"`
        ),
      };
    }
    return out;
  },
  postgres: async (db) => ({
    columns: await db.raw(
      sql`select table_name, column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default from information_schema.columns where table_schema = current_schema() order by table_name, ordinal_position`
    ),
    indexes: await db.raw(sql`select tablename, indexname, indexdef from pg_indexes where schemaname = current_schema() order by tablename, indexname`),
    constraints: await db.raw(
      sql`select c.conrelid::regclass::text as table_name, c.conname as name, pg_get_constraintdef(c.oid) as definition from pg_constraint as c join pg_namespace as n on n.oid = c.connamespace where n.nspname = current_schema() order by 1, 2`
    ),
  }),
  mysql: async (db) => ({
    columns: await db.raw(
      sql`select table_name as t, column_name as c, column_type as type, is_nullable as nullable, column_default as dflt, extra, collation_name as collation from information_schema.columns where table_schema = database() order by table_name, ordinal_position`
    ),
    indexes: await db.raw(
      sql`select table_name as t, index_name as name, non_unique, seq_in_index as seq, column_name as c from information_schema.statistics where table_schema = database() order by table_name, index_name, seq_in_index`
    ),
    foreignKeys: await db.raw(
      sql`select k.table_name as t, k.constraint_name as name, k.column_name as c, k.referenced_table_name as rt, k.referenced_column_name as rc, r.update_rule as on_update, r.delete_rule as on_delete from information_schema.key_column_usage as k join information_schema.referential_constraints as r on r.constraint_schema = k.constraint_schema and r.constraint_name = k.constraint_name where k.table_schema = database() order by k.table_name, k.constraint_name, k.ordinal_position`
    ),
  }),
  mssql: async (db) => ({
    columns: await db.raw(
      sql`select t.name as t, c.name as c, ty.name as type, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, d.name as default_name, d.definition as default_definition from sys.columns as c join sys.tables as t on t.object_id = c.object_id join sys.types as ty on ty.user_type_id = c.user_type_id left join sys.default_constraints as d on d.object_id = c.default_object_id order by t.name, c.column_id`
    ),
    // A primary key declared inline gets a name SQL Server makes up, so it is compared without one.
    indexes: await db.raw(
      sql`select t.name as t, case when i.is_primary_key = 1 then null else i.name end as name, i.is_unique, i.is_primary_key, i.filter_definition, string_agg(c.name, ',') within group (order by ic.key_ordinal) as columns from sys.indexes as i join sys.tables as t on t.object_id = i.object_id join sys.index_columns as ic on ic.object_id = i.object_id and ic.index_id = i.index_id join sys.columns as c on c.object_id = ic.object_id and c.column_id = ic.column_id group by t.name, i.name, i.is_unique, i.is_primary_key, i.filter_definition order by t.name, i.is_primary_key, i.name`
    ),
    foreignKeys: await db.raw(
      sql`select f.name, object_name(f.parent_object_id) as t, object_name(f.referenced_object_id) as rt, f.delete_referential_action_desc as on_delete, f.update_referential_action_desc as on_update from sys.foreign_keys as f order by f.name`
    ),
  }),
};
CATALOG.mariadb = CATALOG.mysql;

// A 0.x migration history, run through Knex on one database and through the compatible builder on another.
const createShop = (schema) =>
  schema
    .createTable("customers", (t) => {
      t.increments("id").primary();
      t.string("name").notNullable();
      t.string("email").unique();
    })
    .createTable("orders", (t) => {
      t.increments("id").primary();
      t.integer("customer_id").unsigned().notNullable().references("id").inTable("customers").onDelete("CASCADE");
      t.decimal("total", 12, 2).notNullable().defaultTo(0);
      t.string("status").defaultTo("new");
      t.boolean("paid").defaultTo(false);
      t.timestamps(true, true);
      t.index(["status"]);
    });

const addNote = (schema) =>
  schema.alterTable("orders", (t) => {
    t.string("note");
    t.renameColumn("status", "state");
  });

const reworkOrders = (schema) =>
  schema
    .alterTable("orders", (t) => {
      t.string("note", 500).notNullable().defaultTo("").alter();
    })
    .alterTable("orders", (t) => {
      t.dropForeign("customer_id");
      t.dropColumn("paid");
    })
    .alterTable("orders", (t) => {
      t.foreign("customer_id").references("customers.id").onDelete("CASCADE");
    });

const dropShop = (schema) =>
  schema
    .alterTable("orders", (t) => {
      t.dropIndex(["status"]);
      t.dropForeign("customer_id");
    })
    .alterTable("customers", (t) => {
      t.dropUnique("email");
    })
    .renameTable("orders", "purchases")
    .dropTable("purchases")
    .dropTableIfExists("customers");

describe("schema changes against a real database", () => {
  for (const engine of loadEngines()) {
    const skip = engine.skip || (engine.id === "sqlite3" ? "the sqlite3 driver is dropped in 1.0" : false);
    describe(engine.label, { skip }, () => {
      const isSqlite = engine.id === "better-sqlite3";
      const dialect = DIALECT[engine.id];
      const suffix = randomBytes(3).toString("hex");
      const databases = { tenora: `tenora_schema_${suffix}`, knex: `tenora_schema_${suffix}_k` };
      const sqliteDir = isSqlite ? fs.mkdtempSync(path.join(os.tmpdir(), "tenora-schema-")) : undefined;
      const sqliteFile = (name) => path.join(sqliteDir, `${name}.sqlite`);
      let admin;
      let db;
      const open = [];

      /** A Tenora connection to one of the test databases. */
      const connect = (database) => {
        const connection = isSqlite
          ? createConnection({
              client: "better-sqlite3",
              connection: { filename: sqliteFile(database) },
              pool: { acquireTimeoutMillis: 5_000 },
            })
          : createConnection(serverConfig(engine, database));
        open.push(connection);
        return connection;
      };

      before(async () => {
        if (!isSqlite) {
          admin = knex(engine.knexConfig(engine.adminDatabase));
          for (const name of Object.values(databases)) await engine.createDatabase(admin, name);
        }
        db = connect(databases.tenora);
      });

      after(async () => {
        for (const connection of open) await connection.destroy();
        if (admin) {
          await engine.cleanup(admin, { databases: Object.values(databases), users: [] });
          await admin.destroy();
        }
        if (sqliteDir) fs.rmSync(sqliteDir, { recursive: true, force: true });
      });

      const dropAll = async (...tables) => {
        for (const table of tables) await db.schema.dropIfExists(table);
      };

      it("creates tables whose defaults, keys and checks hold", async () => {
        try {
          await db.schema.create("teams", (t) => {
            t.id();
            t.string("name").unique();
          });
          await db.schema.create("members", (t) => {
            t.id();
            t.string("email").unique();
            t.foreignId("team_id").constrained().cascadeOnDelete();
            t.boolean("active").default(true);
            t.decimal("balance", 10, 2).default(0);
            t.enum("role", ["admin", "member"]).default("member");
            t.json("meta").nullable();
            t.uuid("token").nullable();
            t.timestamps();
            t.softDeletes();
          });
          const team = await db.table("teams").insertGetId({ name: "red" });
          await db.table("members").insert({ email: "ada@x", team_id: team });
          const ada = await db.table("members").first();
          assert.equal(Number(ada.active), 1);
          assert.equal(Number(ada.balance), 0);
          assert.equal(ada.role, "member");
          assert.equal(ada.created_at, null);
          assert.equal(ada.deleted_at, null);

          await rejects(db.table("members").insert({ email: "ada@x", team_id: team }), "unique_violation");
          await rejects(db.table("members").insert({ email: "bob@x", team_id: team + 1000 }), "foreign_key_violation");
          await rejects(db.table("members").insert({ email: "cy@x", team_id: team, role: "boss" }));

          await db.table("teams").where("id", team).delete();
          assert.equal(await db.table("members").count(), 0, "the delete cascaded");
        } finally {
          await dropAll("members", "teams");
        }
      });

      it("creates every column type and reads a row back", async () => {
        try {
          await db.schema.create("kinds", (t) => {
            t.increments("id");
            t.string("s", 40).default("x");
            t.text("txt").nullable();
            t.integer("i").default(-1);
            t.unsignedInteger("ui").nullable();
            t.bigInteger("bi").default(0);
            t.smallInteger("si").default(0);
            t.boolean("b").default(false);
            t.decimal("d", 8, 3).default(1.5);
            t.float("f").default(0.5);
            t.double("dbl").nullable();
            t.date("dt").nullable();
            t.dateTime("dtm", 3).nullable();
            t.timestamp("ts").useCurrent();
            t.time("tm").nullable();
            t.json("j").default('{"a":1}');
            t.uuid("u").nullable();
            t.binary("bin").nullable();
            t.enum("e", ["x", "y"]).nullable();
          });
          const uuid = "6f1d2a43-5b2c-4a49-9d3c-6c3f1b0c9a11";
          await db.table("kinds").insert({
            txt: "long text",
            ui: 5,
            dbl: 2.25,
            dt: "2024-01-02",
            dtm: new Date("2024-01-02T03:04:05.678Z"),
            tm: "10:11:12",
            u: uuid,
            bin: Buffer.from([1, 2, 3]),
            e: "y",
          });
          const row = await db.table("kinds").first();
          assert.equal(row.s, "x");
          assert.equal(row.txt, "long text");
          assert.deepEqual([row.i, row.ui, row.bi, row.si, row.b, row.d, row.f, row.dbl].map(Number), [-1, 5, 0, 0, 0, 1.5, 0.5, 2.25]);
          assert.ok(row.ts, "useCurrent() set the timestamp");
          assert.deepEqual(typeof row.j === "string" ? JSON.parse(row.j) : row.j, { a: 1 });
          assert.equal(String(row.u).toLowerCase(), uuid);
          assert.ok(Buffer.from(row.bin).equals(Buffer.from([1, 2, 3])));
          assert.equal(row.e, "y");
          assert.ok(row.dt && row.dtm && row.tm);
        } finally {
          await dropAll("kinds");
        }
      });

      it("adds, changes, renames and drops columns, keeping the rows", async () => {
        try {
          await db.schema.create("notes", (t) => {
            t.id();
            t.string("title", 20);
            t.integer("views").default(0);
            t.string("code").nullable();
            t.timestamps();
          });
          await db.table("notes").insert([
            { title: "one", code: null },
            { title: "two", code: "b" },
          ]);

          await db.schema.table("notes", (t) => {
            t.string("summary", 100).nullable().index();
            t.string("title", 200).change();
            t.integer("views").nullable().default(5).change();
            t.renameColumn("code", "slug");
          });
          await db.table("notes").insert({ title: "x".repeat(150), summary: "s" });
          assert.equal(Number(await db.table("notes").where("summary", "s").value("views")), 5, "the new default");
          await db.table("notes").where("title", "one").update({ views: null });
          assert.deepEqual(await db.table("notes").orderBy("id").pluck("slug"), [null, "b", null]);
          await rejects(db.table("notes").insert({ title: null }), "not_null_violation");

          await db.schema.table("notes", (t) => {
            t.dropColumn("views");
            t.dropIndex(["summary"]);
          });
          await db.schema.table("notes", (t) => t.dropColumn(["summary", "created_at"]));
          const [first] = await db.table("notes").orderBy("id").limit(1);
          assert.deepEqual(Object.keys(first).sort(), ["id", "slug", "title", "updated_at"]);
          assert.deepEqual(await db.table("notes").orderBy("id").pluck("title"), ["one", "two", "x".repeat(150)]);

          await db.schema.rename("notes", "memos");
          assert.equal(await db.table("memos").count(), 3);
        } finally {
          await dropAll("notes", "memos");
        }
      });

      it("adds and drops foreign, unique and primary keys on existing tables", async () => {
        try {
          await db.schema.create("authors", (t) => {
            t.id();
            t.string("name");
          });
          await db.schema.create("books", (t) => {
            t.id();
            t.string("isbn", 20);
            t.foreignId("author_id").nullable();
          });
          await db.schema.create("tags", (t) => {
            t.string("name", 50);
          });
          const author = await db.table("authors").insertGetId({ name: "ada" });
          await db.table("books").insert([
            { isbn: "1", author_id: author },
            { isbn: "2", author_id: null },
          ]);
          await db.table("tags").insert({ name: "a" });

          await db.schema.table("books", (t) => {
            t.foreign("author_id").references("id").on("authors").cascadeOnDelete();
            t.unique("isbn");
          });
          await rejects(db.table("books").insert({ isbn: "3", author_id: author + 1000 }), "foreign_key_violation");
          await rejects(db.table("books").insert({ isbn: "1" }), "unique_violation");
          await db.table("authors").where("id", author).delete();
          assert.deepEqual(await db.table("books").pluck("isbn"), ["2"]);

          await db.schema.table("books", (t) => {
            t.dropForeign(["author_id"]);
            t.dropUnique(["isbn"]);
          });
          await db.table("books").insert({ isbn: "2", author_id: 999 });
          assert.equal(await db.table("books").count(), 2);

          await db.schema.table("tags", (t) => {
            t.string("name", 50).change();
            t.primary("name");
          });
          await rejects(db.table("tags").insert({ name: "a" }), "unique_violation");
          await db.schema.table("tags", (t) => t.dropPrimary());
          await db.table("tags").insert({ name: "a" });
          assert.equal(await db.table("tags").count(), 2);
        } finally {
          await dropAll("books", "authors", "tags");
        }
      });

      it("runs a change returned from a transaction callback in that transaction", async () => {
        try {
          await db.transaction(() => db.schema.create("inside", (t) => t.id()));
          await db.transaction(() => db.schema.knex.createTable("inside_knex", (t) => t.increments()));
          assert.equal(await db.table("inside").count(), 0);
          assert.equal(await db.table("inside_knex").count(), 0);
          // MySQL and MariaDB commit DDL implicitly, so only the others can roll a CREATE TABLE back.
          if (dialect !== "mysql" && dialect !== "mariadb") {
            await rejects(
              db.transaction(async () => {
                await db.schema.create("rolled_back", (t) => t.id());
                throw new Error("roll back");
              })
            );
            await rejects(db.table("rolled_back").count());
          }
        } finally {
          await dropAll("inside", "inside_knex", "rolled_back");
        }
      });

      it("builds the same schema and data as Knex from a converted migration", async () => {
        const kx = knex(engine.knexConfig(isSqlite ? sqliteFile(databases.knex) : databases.knex));
        const other = connect(databases.knex);
        const seed = async (connection) => {
          await connection.table("customers").insert({ name: "ada", email: "ada@x" });
          await connection.table("orders").insert({ customer_id: 1, total: 12.5, status: "new" });
        };
        const rows = (connection) =>
          connection.table("orders").select("id", "customer_id", "total", "state", "note").orderBy("id");
        try {
          // Knex's schema builder collects every call made on it, so each step takes a new one, as migrations did.
          for (const [schema, connection] of [
            [() => kx.schema, other],
            [() => db.schema.knex, db],
          ]) {
            await createShop(schema());
            await seed(connection);
            await addNote(schema());
            await connection.table("orders").update({ note: "" });
            await reworkOrders(schema());
          }
          const catalog = await CATALOG[dialect](db);
          assert.match(JSON.stringify(catalog), /"note".*"state"|"state".*"note"/, "the catalog lists the columns");
          assert.deepEqual(catalog, await CATALOG[dialect](other));
          assert.deepEqual(await rows(db), await rows(other));
          assert.equal((await rows(db))[0].state, "new");
          await rejects(db.table("orders").insert({ customer_id: 99, total: 1 }), "foreign_key_violation");

          await dropShop(kx.schema);
          await dropShop(db.schema.knex);
          assert.deepEqual(await CATALOG[dialect](db), await CATALOG[dialect](other));
        } finally {
          await kx.destroy();
          await db.schema.knex.dropTableIfExists("purchases").dropTableIfExists("orders").dropTableIfExists("customers");
        }
      });

      it("answers hasTable and hasColumn, in both schema builders", async () => {
        await db.schema.create("probed", (t) => {
          t.id();
          t.string("label");
        });
        for (const schema of [db.schema, db.schema.knex]) {
          assert.equal(await schema.hasTable("probed"), true);
          assert.equal(await schema.hasTable("not_there"), false);
          assert.equal(await schema.hasColumn("probed", "label"), true);
          assert.equal(await schema.hasColumn("probed", "not_there"), false);
          assert.equal(await schema.hasColumn("not_there", "label"), false);
        }
        await db.schema.drop("probed");
      });

      it("creates tables with the connection's charset and collation", { skip: !["mysql", "mariadb"].includes(dialect) }, async () => {
        const config = serverConfig(engine, databases.tenora);
        const utf = createConnection({
          ...config,
          connection: { ...config.connection, charset: "utf8mb4", collate: "utf8mb4_unicode_ci" },
        });
        try {
          await utf.schema.create("collated_laravel", (t) => t.id());
          await utf.schema.knex.createTable("collated_knex", (t) => t.increments());
          const rows = await utf.raw(
            sql`select table_collation as c from information_schema.tables where table_schema = database() and table_name in ('collated_laravel', 'collated_knex')`
          );
          assert.deepEqual(rows.map((row) => row.c ?? row.C), ["utf8mb4_unicode_ci", "utf8mb4_unicode_ci"]);
        } finally {
          await utf.schema.dropIfExists("collated_laravel");
          await utf.schema.dropIfExists("collated_knex");
          await utf.destroy();
        }
      });

      if (isSqlite) {
        describe("table rebuilds", () => {
          const setUp = async () => {
            await db.schema.create("parents", (t) => {
              t.id();
              t.string("name");
            });
            await db.schema.create("children", (t) => {
              t.id();
              t.foreignId("parent_id").constrained().cascadeOnDelete();
              t.string("label").index();
              t.integer("score");
            });
            await db.raw(
              sql`create trigger children_count after insert on children begin update parents set name = name || '+' where id = new.parent_id; end`
            );
            await db.table("parents").insert([{ name: "a" }, { name: "b" }]);
            await db.table("children").insert([
              { parent_id: 1, label: "x", score: 1 },
              { parent_id: 2, label: "y", score: 2 },
            ]);
          };
          const indexes = async (table) =>
            (await db.raw(sql`select name from pragma_index_list(${table}) order by name`)).map((row) => row.name);
          const columns = async (table) =>
            (await db.raw(sql`select name, type, "notnull" from pragma_table_info(${table})`)).map((column) => [
              column.name,
              column.type,
              column.notnull,
            ]);

          afterEach(() => dropAll("orphans", "children", "parents"));

          it("changes a column's type and nullability, keeping rows, indexes, keys and triggers", async () => {
            await setUp();
            await db.schema.table("children", (t) => {
              t.string("score", 10).change();
              t.string("label").nullable().change();
            });
            // As in Laravel, a changed column is what the new definition says: score is not nullable any more.
            assert.deepEqual(await columns("children"), [
              ["id", "INTEGER", 1],
              ["parent_id", "INTEGER", 1],
              ["label", "varchar", 0],
              ["score", "varchar", 1],
            ]);
            assert.deepEqual(await indexes("children"), ["children_label_index"]);
            assert.deepEqual(await db.table("children").orderBy("id").pluck("score"), ["1", "2"]);
            await db.table("children").insert({ parent_id: 1, label: null, score: "3" });
            assert.equal(await db.table("parents").where("id", 1).value("name"), "a++", "the trigger survived");
            await rejects(db.table("children").insert({ parent_id: 99, score: "4" }), "foreign_key_violation");
          });

          it("drops an indexed column", async () => {
            await setUp();
            await db.schema.table("children", (t) => t.dropColumn("label"));
            assert.deepEqual(await indexes("children"), []);
            assert.deepEqual(await db.table("children").orderBy("id").pluck("score"), [1, 2]);
          });

          it("rebuilds a referenced table without cascading into the tables that reference it", async () => {
            await setUp();
            await db.schema.table("parents", (t) => t.string("name", 50).nullable().change());
            assert.equal(await db.table("children").count(), 2);
            await rejects(db.table("children").insert({ parent_id: 99, label: "z", score: 3 }), "foreign_key_violation");
            await db.table("parents").where("id", 1).delete();
            assert.equal(await db.table("children").count(), 1, "the cascade still works");
          });

          it("refuses to rebuild a referenced table inside a transaction, unless foreign keys are off", async () => {
            await setUp();
            const error = await rejects(db.transaction(() => db.schema.table("parents", (t) => t.text("name").change())));
            assert.match(error.message, /reference it/);
            await db.transaction(() => db.schema.table("children", (t) => t.text("label").change()));
            await db.schema.withoutForeignKeyConstraints(() =>
              db.transaction(() => db.schema.table("parents", (t) => t.text("name").change()))
            );
            assert.equal(await db.table("children").count(), 2);
            assert.deepEqual(await db.raw(sql`pragma foreign_keys`), [{ foreign_keys: 1 }]);
          });

          it("checks foreign keys before it commits", async () => {
            await setUp();
            await db.schema.create("orphans", (t) => {
              t.id();
              t.bigInteger("parent_id");
            });
            await db.table("orphans").insert({ parent_id: 99 });
            const error = await rejects(db.schema.table("orphans", (t) => t.foreign("parent_id").references("id").on("parents")));
            assert.match(error.message, /foreign key/);
            assert.deepEqual(await db.raw(sql`select * from pragma_foreign_key_list('orphans')`), [], "nothing changed");
          });
        });
      }
    });
  }
});
