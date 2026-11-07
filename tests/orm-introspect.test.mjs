import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import knex from "knex";
import {
  BOOKKEEPING_TABLES,
  compareSchemas,
  createConnection,
  describeSchema,
  describeTable,
  hasColumn,
  hasTable,
  listTables,
  sql,
} from "../packages/orm/dist/index.js";
import { loadEngines } from "./support/engines.mjs";

const run = (db, statement) => db.raw(sql`${sql.raw(statement)}`);

/** A column as describeTable() reports it, with the defaults of a plain not-null column. */
const column = (name, type, rawType, extra = {}) => ({
  name,
  type,
  rawType,
  length: null,
  precision: null,
  scale: null,
  nullable: false,
  default: null,
  autoIncrement: false,
  primaryKey: false,
  ...extra,
});

describe("comparing described schemas", () => {
  const table = (overrides = {}) => ({
    name: "posts",
    columns: [
      column("id", "integer", "integer", { autoIncrement: true, primaryKey: true }),
      column("author_id", "integer", "integer", { nullable: true }),
      column("title", "varchar", "varchar(200)", { length: 200, default: "'untitled'" }),
    ],
    primaryKey: ["id"],
    indexes: [{ name: "posts_title_index", columns: ["title"], unique: false }],
    foreignKeys: [
      {
        name: "posts_author_id_foreign",
        columns: ["author_id"],
        referencedTable: "users",
        referencedColumns: ["id"],
        onDelete: "set null",
        onUpdate: "no action",
      },
    ],
    checks: [{ name: "posts_title_check", expression: "title <> ''" }],
    ...overrides,
  });
  const schema = (...tables) => ({ dialect: "postgres", tables });
  const base = schema(table());

  it("finds nothing between equal schemas, whatever the order", () => {
    const users = { ...table(), name: "users", foreignKeys: [] };
    const shuffled = table();
    shuffled.columns.reverse();
    shuffled.indexes = [{ name: "posts_author_index", columns: ["author_id"], unique: false }, ...shuffled.indexes];
    const ordered = table();
    ordered.indexes = [...ordered.indexes, { name: "posts_author_index", columns: ["author_id"], unique: false }];
    assert.deepEqual(compareSchemas(schema(ordered, users), schema(users, shuffled)), []);
  });

  it("reports tables and columns on one side only", () => {
    const fewer = table();
    fewer.columns = fewer.columns.slice(0, 2);
    assert.deepEqual(compareSchemas(base, schema(fewer, { ...table(), name: "audit", foreignKeys: [] })), [
      'table "audit" exists only in b',
      'column "posts"."title" exists only in a',
    ]);
  });

  it("reports changed types, nullability, defaults, auto-increment and primary keys", () => {
    const changed = table({ primaryKey: ["id", "author_id"] });
    changed.columns = [
      column("id", "integer", "integer", { primaryKey: true }),
      column("author_id", "bigint", "bigint", { primaryKey: true }),
      column("title", "varchar", "varchar(250)", { length: 250 }),
    ];
    assert.deepEqual(compareSchemas(base, schema(changed), { labels: ["Knex", "Tenora"] }), [
      'column "posts"."id": auto-increment in Knex, not auto-increment in Tenora',
      'column "posts"."author_id": type integer in Knex, bigint in Tenora',
      'column "posts"."author_id": nullable in Knex, not null in Tenora',
      'column "posts"."title": type varchar(200) in Knex, varchar(250) in Tenora',
      "column \"posts\".\"title\": default 'untitled' in Knex, no default in Tenora",
      'primary key of "posts": (id) in Knex, (id, author_id) in Tenora',
    ]);
  });

  it("compares the base type when the raw types agree", () => {
    const json = table();
    json.columns[2] = { ...json.columns[2], type: "json" };
    assert.deepEqual(compareSchemas(base, schema(json)), ['column "posts"."title": type varchar in a, json in b']);
  });

  it("reports index and foreign key changes", () => {
    const changed = table({
      indexes: [{ name: "posts_title_index", columns: ["title"], unique: true }],
      foreignKeys: [{ ...table().foreignKeys[0], onDelete: "cascade", onUpdate: "cascade" }],
    });
    assert.deepEqual(compareSchemas(base, schema(changed)), [
      'index "posts_title_index" on "posts": not unique in a, unique in b',
      'foreign key "posts_author_id_foreign" on "posts": on delete set null in a, cascade in b',
      'foreign key "posts_author_id_foreign" on "posts": on update no action in a, cascade in b',
    ]);

    const missing = table({ indexes: [], foreignKeys: [] });
    assert.deepEqual(compareSchemas(base, schema(missing)), [
      'index "posts_title_index" on "posts" (title) exists only in a',
      'foreign key "posts_author_id_foreign" on "posts" (author_id) references "users" (id) exists only in a',
    ]);

    const moved = table({ indexes: [{ name: "posts_title_index", columns: ["title", "id"], unique: false }] });
    assert.deepEqual(compareSchemas(base, schema(moved)), [
      'index "posts_title_index" on "posts": columns (title) in a, (title, id) in b',
    ]);
  });

  it("reports names unless asked to ignore them", () => {
    const renamed = table({
      indexes: [{ name: "posts_title_idx", columns: ["title"], unique: false }],
      foreignKeys: [{ ...table().foreignKeys[0], name: "posts_author_id_fkey" }],
    });
    assert.deepEqual(compareSchemas(base, schema(renamed)), [
      'index on "posts" (title): named "posts_title_index" in a, named "posts_title_idx" in b',
      'foreign key on "posts" (author_id) references "users" (id): named "posts_author_id_foreign" in a, named "posts_author_id_fkey" in b',
    ]);
    assert.deepEqual(compareSchemas(base, schema(renamed), { ignoreNames: true }), []);

    // A renamed index whose uniqueness also changed is still one index.
    const both = table({ indexes: [{ name: "posts_title_unique", columns: ["title"], unique: true }] });
    assert.deepEqual(compareSchemas(base, schema(both), { ignoreNames: true }), [
      'index "posts_title_index" on "posts": not unique in a, unique in b',
    ]);
  });

  it("treats names SQL Server generated as equal to each other, but not to a given name", () => {
    const generated = (name) =>
      table({ foreignKeys: [{ ...table().foreignKeys[0], name, systemNamed: true }] });
    const mssql = (t) => ({ dialect: "mssql", tables: [t] });
    assert.deepEqual(
      compareSchemas(mssql(generated("FK__posts__autho__3B75D760")), mssql(generated("FK__posts__autho__5070F446"))),
      []
    );
    assert.deepEqual(compareSchemas(mssql(table()), mssql(generated("FK__posts__autho__5070F446"))), [
      'foreign key on "posts" (author_id) references "users" (id): named "posts_author_id_foreign" in a, named "FK__posts__autho__5070F446" by the server in b',
    ]);
  });

  it("reports an unnamed SQLite foreign key against a named one", () => {
    const unnamed = table({ foreignKeys: [{ ...table().foreignKeys[0], name: null }] });
    const sqlite = (t) => ({ dialect: "sqlite", tables: [t] });
    assert.deepEqual(compareSchemas(sqlite(unnamed), sqlite(unnamed)), []);
    assert.deepEqual(compareSchemas(sqlite(unnamed), sqlite(table())), [
      'foreign key on "posts" (author_id) references "users" (id): unnamed in a, named "posts_author_id_foreign" in b',
    ]);
  });

  it("reports a partial index whose condition changed", () => {
    const partial = table({ indexes: [{ name: "posts_title_index", columns: ["title"], unique: false, where: "title IS NOT NULL" }] });
    assert.deepEqual(compareSchemas(base, schema(partial)), [
      'index "posts_title_index" on "posts": no condition in a, where title IS NOT NULL in b',
    ]);
    assert.deepEqual(compareSchemas(schema(partial), schema(table({ indexes: [] }))), [
      'index "posts_title_index" on "posts" (title) where title IS NOT NULL exists only in a',
    ]);
  });

  it("reports check constraints", () => {
    const changed = table({ checks: [{ name: "posts_title_check", expression: "length(title) > 3" }] });
    assert.deepEqual(compareSchemas(base, schema(changed)), [
      "check \"posts_title_check\" on \"posts\": (title <> '') in a, (length(title) > 3) in b",
    ]);
    const renamed = table({ checks: [{ name: "posts_title_not_empty", expression: "title <> ''" }] });
    assert.deepEqual(compareSchemas(base, schema(renamed)), [
      "check on \"posts\" (title <> ''): named \"posts_title_check\" in a, named \"posts_title_not_empty\" in b",
    ]);
    assert.deepEqual(compareSchemas(base, schema(renamed), { ignoreNames: true }), []);
    assert.deepEqual(compareSchemas(base, schema(table({ checks: [] }))), [
      "check \"posts_title_check\" on \"posts\" (title <> '') exists only in a",
    ]);
  });

  it("refuses schemas from different dialects", () => {
    assert.throws(() => compareSchemas(base, { dialect: "mysql", tables: [] }), /^Error: Tenora: cannot compare a postgres schema with a mysql schema\.$/);
  });
});

/** The test schema for each dialect; `changed` makes a title longer, drops an index, adds a column and cascades. */
const schemaDdl = (dialect, changed = false) => {
  const title = changed ? 250 : 200;
  const onDelete = changed ? "cascade" : "set null";
  const nickname = (type) => (changed ? `nickname ${type} null,` : "");
  const nameIndex = changed ? [] : ["create index users_name_status_index on users (name, status)"];
  // Knex's unique() on SQL Server: a unique index that leaves nulls out. MySQL has no partial indexes.
  const externalIdIndex =
    dialect === "mysql" || dialect === "mariadb"
      ? "create unique index users_external_id_unique on users (external_id)"
      : "create unique index users_external_id_unique on users (external_id) where external_id is not null";
  switch (dialect) {
    case "postgres":
      return [
        "create table teams (id serial primary key, name varchar(100) not null, constraint teams_name_unique unique (name))",
        `create table users (
          id bigint generated by default as identity primary key,
          email varchar(255) not null,
          name varchar(100),
          ${nickname("varchar(50)")}
          active boolean not null default true,
          score numeric(8,2) not null default 0,
          ratio double precision,
          bio text,
          status varchar(20) not null default 'new' check (status in ('new', 'active')),
          created_at timestamptz not null default current_timestamp,
          birthday date,
          external_id uuid,
          data jsonb
        )`,
        "create unique index users_email_unique on users (email)",
        ...nameIndex,
        externalIdIndex,
        `create table memberships (
          user_id bigint not null references users (id) on delete cascade,
          team_id integer not null,
          role varchar(20) not null default 'member',
          primary key (team_id, user_id),
          constraint memberships_team_id_foreign foreign key (team_id) references teams (id) on delete cascade on update cascade
        )`,
        "create index memberships_role_index on memberships (role)",
        `create table posts (
          id serial primary key,
          author_id bigint,
          title varchar(${title}) not null,
          constraint posts_author_id_foreign foreign key (author_id) references users (id) on delete ${onDelete}
        )`,
        "create index posts_author_id_title_index on posts (author_id, title)",
      ];
    case "mysql":
    case "mariadb":
      return [
        "create table teams (id int unsigned not null auto_increment primary key, name varchar(100) not null, constraint teams_name_unique unique (name))",
        `create table users (
          id bigint unsigned not null auto_increment primary key,
          email varchar(255) not null,
          name varchar(100) null,
          ${nickname("varchar(50)")}
          active tinyint(1) not null default 1,
          score decimal(8,2) not null default 0,
          ratio double null,
          bio text null,
          status varchar(20) not null default 'new' check (status in ('new', 'active')),
          created_at datetime not null default current_timestamp,
          birthday date null,
          external_id char(36) null,
          data json null,
          unique key users_email_unique (email)
        )`,
        ...nameIndex,
        externalIdIndex,
        `create table memberships (
          user_id bigint unsigned not null,
          team_id int unsigned not null,
          role varchar(20) not null default 'member',
          primary key (team_id, user_id),
          foreign key (user_id) references users (id) on delete cascade,
          constraint memberships_team_id_foreign foreign key (team_id) references teams (id) on delete cascade on update cascade,
          key memberships_role_index (role)
        )`,
        `create table posts (
          id int unsigned not null auto_increment primary key,
          author_id bigint unsigned null,
          title varchar(${title}) not null,
          key posts_author_id_title_index (author_id, title),
          constraint posts_author_id_foreign foreign key (author_id) references users (id) on delete ${onDelete}
        )`,
      ];
    case "sqlite":
      return [
        "create table teams (id integer not null primary key autoincrement, name varchar(100) not null, constraint teams_name_unique unique (name))",
        `create table users (
          id integer primary key autoincrement,
          email varchar(255) not null,
          name varchar(100),
          ${nickname("varchar(50)")}
          active boolean not null default 1,
          score decimal(8, 2) not null default 0,
          ratio float,
          bio text,
          status varchar(20) not null default 'new' check (status in ('new', 'active')),
          created_at datetime not null default CURRENT_TIMESTAMP,
          birthday date,
          external_id char(36),
          data json
        )`,
        "create unique index users_email_unique on users (email)",
        ...nameIndex,
        externalIdIndex,
        `create table memberships (
          user_id integer not null references users (id) on delete cascade,
          team_id integer not null,
          role varchar(20) not null default 'member',
          primary key (team_id, user_id),
          constraint memberships_team_id_foreign foreign key (team_id) references teams (id) on delete cascade on update cascade
        )`,
        "create index memberships_role_index on memberships (role)",
        // REFERENCES without columns means the primary key; a plain INTEGER PRIMARY KEY is not AUTOINCREMENT.
        `create table posts (
          id integer primary key,
          author_id integer,
          title varchar(${title}) not null,
          constraint posts_author_id_foreign foreign key (author_id) references users on delete ${onDelete}
        )`,
        "create index posts_author_id_title_index on posts (author_id, title)",
      ];
    case "mssql":
      // Unnamed defaults, primary keys and one foreign key get names with random suffixes.
      return [
        "create table teams (id int identity(1,1) not null primary key, name nvarchar(100) not null, constraint teams_name_unique unique (name))",
        `create table users (
          id bigint identity(1,1) not null primary key,
          email nvarchar(255) not null,
          name nvarchar(100) null,
          ${nickname("nvarchar(50)")}
          active bit not null default 1,
          score decimal(8,2) not null default 0,
          ratio float null,
          bio nvarchar(max) null,
          status nvarchar(20) not null constraint users_status_default default 'new' check (status in ('new', 'active')),
          created_at datetime2 not null default current_timestamp,
          birthday date null,
          external_id uniqueidentifier null,
          data nvarchar(max) null
        )`,
        "create unique index users_email_unique on users (email)",
        ...nameIndex,
        externalIdIndex,
        `create table memberships (
          user_id bigint not null references users (id) on delete cascade,
          team_id int not null,
          role nvarchar(20) not null default 'member',
          primary key (team_id, user_id),
          constraint memberships_team_id_foreign foreign key (team_id) references teams (id) on delete cascade on update cascade
        )`,
        "create index memberships_role_index on memberships (role)",
        `create table posts (
          id int identity(1,1) not null primary key,
          author_id bigint null,
          title nvarchar(${title}) not null,
          constraint posts_author_id_foreign foreign key (author_id) references users (id) on delete ${onDelete}
        )`,
        "create index posts_author_id_title_index on posts (author_id, title)",
      ];
  }
};

const BOOKKEEPING_DDL = ["knex_migrations", "knex_migrations_lock", "tenora_migrations", "tenora_migrations_lock"].map(
  (name) => `create table ${name} (id int not null primary key)`
);

/** The users table as each database describes it. */
const USERS = {
  postgres: [
    column("id", "bigint", "bigint", { autoIncrement: true, primaryKey: true }),
    column("email", "varchar", "character varying(255)", { length: 255 }),
    column("name", "varchar", "character varying(100)", { length: 100, nullable: true }),
    column("active", "boolean", "boolean", { default: "true" }),
    column("score", "numeric", "numeric(8,2)", { precision: 8, scale: 2, default: "0" }),
    column("ratio", "double precision", "double precision", { nullable: true }),
    column("bio", "text", "text", { nullable: true }),
    column("status", "varchar", "character varying(20)", { length: 20, default: "'new'" }),
    column("created_at", "timestamptz", "timestamp with time zone", { default: "CURRENT_TIMESTAMP" }),
    column("birthday", "date", "date", { nullable: true }),
    column("external_id", "uuid", "uuid", { nullable: true }),
    column("data", "jsonb", "jsonb", { nullable: true }),
  ],
  mysql: [
    column("id", "bigint", "bigint unsigned", { autoIncrement: true, primaryKey: true }),
    column("email", "varchar", "varchar(255)", { length: 255 }),
    column("name", "varchar", "varchar(100)", { length: 100, nullable: true }),
    column("active", "tinyint", "tinyint(1)", { default: "1" }),
    column("score", "decimal", "decimal(8,2)", { precision: 8, scale: 2, default: "0.00" }),
    column("ratio", "double", "double", { nullable: true }),
    column("bio", "text", "text", { nullable: true }),
    column("status", "varchar", "varchar(20)", { length: 20, default: "'new'" }),
    column("created_at", "datetime", "datetime", { default: "CURRENT_TIMESTAMP" }),
    column("birthday", "date", "date", { nullable: true }),
    column("external_id", "char", "char(36)", { length: 36, nullable: true }),
    column("data", "json", "json", { nullable: true }),
  ],
  // MariaDB keeps integer display widths, spells the timestamp default as a function, and stores json as longtext.
  mariadb: [
    column("id", "bigint", "bigint(20) unsigned", { autoIncrement: true, primaryKey: true }),
    column("email", "varchar", "varchar(255)", { length: 255 }),
    column("name", "varchar", "varchar(100)", { length: 100, nullable: true }),
    column("active", "tinyint", "tinyint(1)", { default: "1" }),
    column("score", "decimal", "decimal(8,2)", { precision: 8, scale: 2, default: "0.00" }),
    column("ratio", "double", "double", { nullable: true }),
    column("bio", "text", "text", { nullable: true }),
    column("status", "varchar", "varchar(20)", { length: 20, default: "'new'" }),
    column("created_at", "datetime", "datetime", { default: "current_timestamp()" }),
    column("birthday", "date", "date", { nullable: true }),
    column("external_id", "char", "char(36)", { length: 36, nullable: true }),
    column("data", "json", "longtext", { nullable: true }),
  ],
  sqlite: [
    column("id", "integer", "integer", { autoIncrement: true, primaryKey: true }),
    column("email", "varchar", "varchar(255)", { length: 255 }),
    column("name", "varchar", "varchar(100)", { length: 100, nullable: true }),
    column("active", "boolean", "boolean", { default: "1" }),
    column("score", "decimal", "decimal(8,2)", { precision: 8, scale: 2, default: "0" }),
    column("ratio", "float", "float", { nullable: true }),
    column("bio", "text", "text", { nullable: true }),
    column("status", "varchar", "varchar(20)", { length: 20, default: "'new'" }),
    column("created_at", "datetime", "datetime", { default: "CURRENT_TIMESTAMP" }),
    column("birthday", "date", "date", { nullable: true }),
    column("external_id", "char", "char(36)", { length: 36, nullable: true }),
    column("data", "json", "json", { nullable: true }),
  ],
  mssql: [
    column("id", "bigint", "bigint", { autoIncrement: true, primaryKey: true }),
    column("email", "nvarchar", "nvarchar(255)", { length: 255 }),
    column("name", "nvarchar", "nvarchar(100)", { length: 100, nullable: true }),
    column("active", "bit", "bit", { default: "1" }),
    column("score", "decimal", "decimal(8,2)", { precision: 8, scale: 2, default: "0" }),
    column("ratio", "float", "float", { nullable: true }),
    column("bio", "nvarchar", "nvarchar(max)", { nullable: true }),
    column("status", "nvarchar", "nvarchar(20)", { length: 20, default: "'new'" }),
    column("created_at", "datetime2", "datetime2(7)", { precision: 7, default: "getdate()" }),
    column("birthday", "date", "date", { nullable: true }),
    column("external_id", "uniqueidentifier", "uniqueidentifier", { nullable: true }),
    column("data", "nvarchar", "nvarchar(max)", { nullable: true }),
  ],
};

/** [type, rawType] of the key and text columns of the other tables. */
const TYPES = {
  postgres: { int: ["integer", "integer"], bigint: ["bigint", "bigint"], text: (n) => ["varchar", `character varying(${n})`] },
  mysql: { int: ["int", "int unsigned"], bigint: ["bigint", "bigint unsigned"], text: (n) => ["varchar", `varchar(${n})`] },
  mariadb: {
    int: ["int", "int(10) unsigned"],
    bigint: ["bigint", "bigint(20) unsigned"],
    text: (n) => ["varchar", `varchar(${n})`],
  },
  sqlite: { int: ["integer", "integer"], bigint: ["integer", "integer"], text: (n) => ["varchar", `varchar(${n})`] },
  mssql: { int: ["int", "int"], bigint: ["bigint", "bigint"], text: (n) => ["nvarchar", `nvarchar(${n})`] },
};

const expectedTables = (dialect) => {
  const { int, bigint, text } = TYPES[dialect];
  const serialDefault = (table) => (dialect === "postgres" ? { default: `nextval('${table}_id_seq')` } : {});
  // A foreign key without ON UPDATE: MariaDB reports RESTRICT where the others report NO ACTION.
  const noAction = dialect === "mariadb" ? "restrict" : "no action";

  const unnamedForeignKey = {
    name: { postgres: "memberships_user_id_fkey", mysql: "memberships_ibfk_1", mariadb: "1", sqlite: null, mssql: "(generated)" }[dialect],
    columns: ["user_id"],
    referencedTable: "users",
    referencedColumns: ["id"],
    onDelete: "cascade",
    onUpdate: noAction,
    ...(dialect === "mssql" ? { systemNamed: true } : {}),
  };
  const namedForeignKey = {
    name: "memberships_team_id_foreign",
    columns: ["team_id"],
    referencedTable: "teams",
    referencedColumns: ["id"],
    onDelete: "cascade",
    onUpdate: "cascade",
  };

  return {
    teams: {
      name: "teams",
      columns: [
        column("id", ...int, { autoIncrement: true, primaryKey: true, ...serialDefault("teams") }),
        column("name", ...text(100), { length: 100 }),
      ],
      primaryKey: ["id"],
      // SQLite names the index of a UNIQUE constraint itself.
      indexes: [{ name: dialect === "sqlite" ? "sqlite_autoindex_teams_1" : "teams_name_unique", columns: ["name"], unique: true }],
      foreignKeys: [],
      checks: [],
    },
    users: {
      name: "users",
      columns: USERS[dialect],
      primaryKey: ["id"],
      indexes: [
        { name: "users_email_unique", columns: ["email"], unique: true },
        {
          name: "users_external_id_unique",
          columns: ["external_id"],
          unique: true,
          ...{
            postgres: { where: "external_id IS NOT NULL" },
            sqlite: { where: "external_id is not null" },
            mssql: { where: "[external_id] IS NOT NULL" },
          }[dialect],
        },
        { name: "users_name_status_index", columns: ["name", "status"], unique: false },
      ],
      foreignKeys: [],
      // Each database names an unnamed check its own way and keeps the condition in its own words.
      checks: [
        {
          postgres: {
            name: "users_status_check",
            expression: "status::text = ANY (ARRAY['new'::character varying, 'active'::character varying]::text[])",
          },
          mysql: { name: "users_chk_1", expression: "(`status` in (_utf8mb4'new',_utf8mb4'active'))" },
          mariadb: { name: "status", expression: "`status` in ('new','active')" },
          sqlite: { name: null, expression: "status in ('new', 'active')" },
          // SQL Server rewrites IN as ORs, last value first.
          mssql: { name: "(generated)", expression: "[status]='active' OR [status]='new'", systemNamed: true },
        }[dialect],
      ],
    },
    memberships: {
      name: "memberships",
      columns: [
        column("user_id", ...bigint, { primaryKey: true }),
        column("team_id", ...int, { primaryKey: true }),
        column("role", ...text(20), { length: 20, default: "'member'" }),
      ],
      // In key order, not column order.
      primaryKey: ["team_id", "user_id"],
      indexes: [
        { name: "memberships_role_index", columns: ["role"], unique: false },
        // MySQL and MariaDB index a foreign key's columns when no index starts with them.
        ...(dialect === "mysql" || dialect === "mariadb" ? [{ name: "user_id", columns: ["user_id"], unique: false }] : []),
      ],
      foreignKeys: dialect === "postgres" ? [namedForeignKey, unnamedForeignKey] : [unnamedForeignKey, namedForeignKey],
      checks: [],
    },
    posts: {
      name: "posts",
      columns: [
        // SQLite's plain INTEGER PRIMARY KEY is the rowid: never null, but not AUTOINCREMENT.
        column("id", ...int, { autoIncrement: dialect !== "sqlite", primaryKey: true, ...serialDefault("posts") }),
        column("author_id", ...bigint, { nullable: true }),
        column("title", ...text(200), { length: 200 }),
      ],
      primaryKey: ["id"],
      indexes: [{ name: "posts_author_id_title_index", columns: ["author_id", "title"], unique: false }],
      foreignKeys: [
        {
          name: "posts_author_id_foreign",
          columns: ["author_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
          onDelete: "set null",
          onUpdate: noAction,
        },
      ],
      checks: [],
    },
  };
};

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
    pool: { max: 3, acquireTimeoutMillis: 5_000 },
  };
};

describe("introspection against a real database", () => {
  for (const engine of loadEngines()) {
    const skip = engine.skip || (engine.id === "sqlite3" ? "the sqlite3 driver is dropped in 1.0" : false);
    describe(engine.label, { skip }, () => {
      const dialect = DIALECT[engine.id];
      const isSqlite = dialect === "sqlite";
      const prefix = `tenora_introspect_${randomBytes(3).toString("hex")}`;
      const names = { same: `${prefix}_a`, twin: `${prefix}_b`, changed: `${prefix}_c` };
      const sqliteDir = isSqlite ? fs.mkdtempSync(path.join(os.tmpdir(), "tenora-introspect-")) : undefined;
      let admin;
      const db = {};

      const open = async (database, statements) => {
        let connection;
        if (isSqlite) {
          connection = createConnection({
            client: "better-sqlite3",
            connection: { filename: path.join(sqliteDir, `${database}.sqlite`) },
          });
        } else {
          await engine.createDatabase(admin, database);
          connection = createConnection(serverConfig(engine, database));
        }
        for (const statement of statements) await run(connection, statement);
        return connection;
      };

      before(async () => {
        if (!isSqlite) admin = knex(engine.knexConfig(engine.adminDatabase));
        db.same = await open(names.same, [...schemaDdl(dialect), ...BOOKKEEPING_DDL]);
        db.twin = await open(names.twin, schemaDdl(dialect));
        db.changed = await open(names.changed, schemaDdl(dialect, true));
      });

      after(async () => {
        for (const connection of Object.values(db)) await connection.destroy();
        if (admin) {
          await engine.cleanup(admin, { databases: Object.values(names), users: [] });
          await admin.destroy();
        }
        if (sqliteDir) fs.rmSync(sqliteDir, { recursive: true, force: true });
      });

      it("lists tables, leaving out the bookkeeping tables when asked", async () => {
        assert.deepEqual(await listTables(db.same), [
          "knex_migrations",
          "knex_migrations_lock",
          "memberships",
          "posts",
          "teams",
          "tenora_migrations",
          "tenora_migrations_lock",
          "users",
        ]);
        assert.deepEqual(await listTables(db.same, { exclude: BOOKKEEPING_TABLES }), ["memberships", "posts", "teams", "users"]);
        assert.deepEqual(await listTables(db.same, { exclude: [...BOOKKEEPING_TABLES, "team*", /^USERS$/i] }), [
          "memberships",
          "posts",
        ]);
      });

      it("finds tables and columns", async () => {
        assert.equal(await hasTable(db.same, "users"), true);
        assert.equal(await hasTable(db.same, "nothing"), false);
        assert.equal(await hasColumn(db.same, "users", "email"), true);
        assert.equal(await hasColumn(db.same, "users", "nickname"), false);
        assert.equal(await hasColumn(db.changed, "users", "nickname"), true);
        assert.equal(await hasColumn(db.same, "nothing", "email"), false);
        // Postgres column names are case-sensitive; the others ignore case.
        assert.equal(await hasColumn(db.same, "users", "EMAIL"), dialect !== "postgres");
      });

      it("describes columns, keys and indexes as the catalog has them", async () => {
        const expected = expectedTables(dialect);
        for (const name of ["teams", "users", "memberships", "posts"]) {
          const actual = await describeTable(db.same, name);
          // SQL Server's generated names end in a random suffix.
          for (const fk of actual.foreignKeys) {
            if (fk.systemNamed) {
              assert.match(fk.name, /^FK__membershi__user___[0-9A-F]{8}$/);
              fk.name = "(generated)";
            }
          }
          for (const check of actual.checks) {
            if (check.systemNamed) {
              assert.match(check.name, /^CK__users__status__[0-9A-F]{8}$/);
              check.name = "(generated)";
            }
          }
          assert.deepEqual(actual, expected[name], name);
        }
      });

      it("refuses to describe a table that does not exist", async () => {
        await assert.rejects(
          describeTable(db.same, "nothing"),
          new RegExp(`^Error: Tenora: there is no table "nothing" in the current ${dialect} schema\\.$`)
        );
      });

      it("finds no difference between two databases built from the same DDL", async () => {
        const options = { exclude: BOOKKEEPING_TABLES };
        const [a, b] = [await describeSchema(db.same, options), await describeSchema(db.twin, options)];
        assert.deepEqual(a.tables.map((table) => table.name), ["memberships", "posts", "teams", "users"]);
        assert.deepEqual(compareSchemas(a, b), []);
        assert.deepEqual(compareSchemas(a, b, { ignoreNames: true }), []);
        // Without the exclusion, the bookkeeping tables are a difference too.
        assert.deepEqual(compareSchemas(await describeSchema(db.same), b), [
          'table "knex_migrations" exists only in a',
          'table "knex_migrations_lock" exists only in a',
          'table "tenora_migrations" exists only in a',
          'table "tenora_migrations_lock" exists only in a',
        ]);
      });

      it("reports a changed type, a missing index, an extra column and a different onDelete", async () => {
        const options = { exclude: BOOKKEEPING_TABLES };
        const [a, c] = [await describeSchema(db.same, options), await describeSchema(db.changed, options)];
        const [, title200] = TYPES[dialect].text(200);
        const [, title250] = TYPES[dialect].text(250);
        const expected = [
          `column "posts"."title": type ${title200} in Knex, ${title250} in Tenora`,
          'foreign key "posts_author_id_foreign" on "posts": on delete set null in Knex, cascade in Tenora',
          'column "users"."nickname" exists only in Tenora',
          'index "users_name_status_index" on "users" (name, status) exists only in Knex',
        ];
        assert.deepEqual(compareSchemas(a, c, { labels: ["Knex", "Tenora"] }), expected);
        assert.deepEqual(compareSchemas(a, c, { labels: ["Knex", "Tenora"], ignoreNames: true }), expected);
        assert.deepEqual(compareSchemas(c, a, { labels: ["Tenora", "Knex"] }), [
          `column "posts"."title": type ${title250} in Tenora, ${title200} in Knex`,
          'foreign key "posts_author_id_foreign" on "posts": on delete cascade in Tenora, set null in Knex',
          'column "users"."nickname" exists only in Tenora',
          'index "users_name_status_index" on "users" (name, status) exists only in Knex',
        ]);
      });

      // MySQL and MariaDB commit DDL on their own, so only the others can show uncommitted tables.
      it("sees uncommitted DDL inside the ambient transaction", { skip: dialect === "mysql" || dialect === "mariadb" }, async () => {
        const rollback = new Error("roll back");
        await assert.rejects(
          db.twin.transaction(async () => {
            await run(db.twin, "create table drafts (id int not null primary key, body text)");
            assert.equal(await hasTable(db.twin, "drafts"), true);
            assert.equal(await hasColumn(db.twin, "drafts", "body"), true);
            assert.deepEqual((await describeTable(db.twin, "drafts")).primaryKey, ["id"]);
            throw rollback;
          }),
          (error) => error === rollback
        );
        assert.equal(await hasTable(db.twin, "drafts"), false);
      });
    });
  }
});

describe("introspecting SQLite's DDL", () => {
  let db;
  before(() => {
    db = createConnection({ client: "better-sqlite3", connection: { filename: ":memory:" } });
  });
  after(() => db.destroy());

  it("reads foreign key names, AUTOINCREMENT and expressions from the statements SQLite keeps", async () => {
    for (const statement of [
      'create table "Parent Table" ([key] integer primary key autoincrement, "code" text unique)',
      `create table child (
        id integer not null, -- a comment with references and ( parentheses
        parent_key integer constraint "child parent" references "Parent Table" on delete cascade,
        parent_code text references "Parent Table" ("code") on update set null,
        note text check (note <> 'references x(y)') default ('a, b'),
        /* a key, later */
        constraint child_pk primary key (id),
        constraint "positive id" check (id > 0)
      ) without rowid`,
      "create index child_note_lower on child (lower(note), id)",
    ]) {
      await run(db, statement);
    }

    const parent = await describeTable(db, "parent table");
    assert.equal(parent.name, "Parent Table");
    assert.deepEqual(parent.columns[0], column("key", "integer", "integer", { autoIncrement: true, primaryKey: true }));
    assert.deepEqual(parent.indexes, [{ name: "sqlite_autoindex_Parent Table_1", columns: ["code"], unique: true }]);

    const child = await describeTable(db, "child");
    // WITHOUT ROWID: an INTEGER PRIMARY KEY is an ordinary column, and NOT NULL comes from the DDL.
    assert.deepEqual(child.columns[0], column("id", "integer", "integer", { primaryKey: true }));
    assert.equal(child.columns[3].default, "'a, b'");
    assert.deepEqual(child.indexes, [{ name: "child_note_lower", columns: ["lower(note)", "id"], unique: false }]);
    assert.deepEqual(child.checks, [
      { name: null, expression: "note <> 'references x(y)'" },
      { name: "positive id", expression: "id > 0" },
    ]);
    assert.deepEqual(child.foreignKeys, [
      {
        name: null,
        columns: ["parent_code"],
        referencedTable: "Parent Table",
        referencedColumns: ["code"],
        onDelete: "no action",
        onUpdate: "set null",
      },
      {
        name: "child parent",
        columns: ["parent_key"],
        referencedTable: "Parent Table",
        referencedColumns: ["key"],
        onDelete: "cascade",
        onUpdate: "no action",
      },
    ]);
  });

  it("tells AUTOINCREMENT apart from a plain INTEGER PRIMARY KEY", async () => {
    await run(db, "create table counted (id integer primary key autoincrement)");
    await run(db, "create table plain (id integer primary key)");
    const [counted, plain] = [await describeTable(db, "counted"), await describeTable(db, "plain")];
    assert.deepEqual(
      compareSchemas({ dialect: "sqlite", tables: [{ ...counted, name: "t" }] }, { dialect: "sqlite", tables: [{ ...plain, name: "t" }] }),
      ['column "t"."id": auto-increment in a, not auto-increment in b']
    );
  });
});
