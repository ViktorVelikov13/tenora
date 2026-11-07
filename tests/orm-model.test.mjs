import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import knex from "knex";
import {
  cast,
  createConnection,
  MassAssignmentError,
  Model,
  MODEL_EVENTS,
  ModelNotFoundError,
  ModelQuery,
  naming,
  RelationNotLoadedError,
  scope,
  setConnectionResolver,
  sql,
} from "../packages/orm/dist/index.js";
import { loadEngines } from "./support/engines.mjs";

// Models are plain JavaScript here, as many Tenora users write them: no `declare`, nothing to compile.

class User extends Model {
  static fillable = ["name", "email", "isAdmin", "settings", "bornOn", "lastSeenAt", "votes", "teamId"];
  static casts = { isAdmin: "boolean", settings: cast.json(), bornOn: "date", lastSeenAt: "datetime" };

  static active = scope((query) => query.where("isAdmin", true));
  static withVotes = scope((query, min) => query.where("votes", ">=", min));
}

class Post extends Model {
  static fillable = ["userId", "title", "published"];
  static casts = { published: "boolean" };
  static softDeletes = true;
}

class Audit extends Model {
  static timestamps = false;
  static fillable = ["event", "subject"];
}

class Tag extends Model {
  static primaryKey = "code";
  static incrementing = false;
  static timestamps = false;
  static fillable = ["code", "label"];
}

// A model of the same table that keeps the database's column names.
class RawUser extends Model {
  static table = "users";
  static naming = naming.none;
  static guarded = [];
  static CREATED_AT = "created_at";
  static UPDATED_AT = "updated_at";
}

const MODELS = [User, Post, Audit, Tag, RawUser];

describe("models without a database", () => {
  const db = createConnection({ client: "pg", connection: {} });
  const mysql = createConnection({ client: "mysql2", connection: {} });

  afterEach(() => setConnectionResolver(undefined));

  it("names a model's table after its class, unless it sets one", () => {
    class OrderItem extends Model {}
    class Category extends Model {}
    class Person extends Model {}
    class Box extends Model {}
    assert.deepEqual(
      [User, OrderItem, Category, Person, Box, RawUser].map((model) => model.getTable()),
      ["users", "order_items", "categories", "people", "boxes", "users"]
    );
  });

  it("maps attribute names to columns in conditions, selects and order", () => {
    const query = User.on(db)
      .where("isAdmin", true)
      .whereIn("users.teamId", [1, 2])
      .whereNotNull("lastSeenAt")
      .select("id", "users.teamId", "lastSeenAt as seen")
      .orderBy("createdAt", "desc");
    assert.deepEqual(query.toSql(), {
      sql: 'select "id", "users"."team_id", "last_seen_at" as "seen" from "users" where ("is_admin" = $1 and "users"."team_id" in ($2, $3) and "last_seen_at" is not null) order by "created_at" desc',
      parameters: [true, 1, 2],
    });
    assert.equal(RawUser.on(db).where("is_admin", true).toSql().sql, 'select * from "users" where "is_admin" = $1');
    assert.equal(User.on(mysql).latest().toSql().sql, "select * from `users` order by `created_at` desc");
  });

  it("groups or-conditions before soft deletes and global scopes add theirs", () => {
    class Article extends Model {
      static softDeletes = true;
      static globalScopes = { published: (query) => query.where("published", true) };
    }
    const query = Article.on(db).where("title", "a").orWhere("title", "b");
    assert.equal(
      query.toSql().sql,
      'select * from "articles" where (("title" = $1 or "title" = $2) and "published" = $3 and "articles"."deleted_at" is null)'
    );
    assert.equal(
      query.withoutGlobalScope("published").withTrashed().toSql().sql,
      'select * from "articles" where ("title" = $1 or "title" = $2)'
    );
    assert.equal(
      Article.on(db).onlyTrashed().toSql().sql,
      'select * from "articles" where ("published" = $1 and "articles"."deleted_at" is not null)'
    );
    assert.equal(Article.on(db).withoutGlobalScopes().toSql().sql, 'select * from "articles"');
    // A scope's own or-conditions are grouped too, so they cannot widen the query.
    class Loose extends Model {
      static table = "articles";
      static globalScopes = { either: (query) => query.where("a", 1).orWhere("b", 2) };
    }
    assert.equal(
      Loose.on(db).where("c", 3).toSql().sql,
      'select * from "articles" where ("c" = $1 and ("a" = $2 or "b" = $3))'
    );
  });

  it("applies local scopes, with arguments, and nested conditions on attribute names", () => {
    const query = User.on(db)
      .apply(User.active)
      .apply(User.withVotes, 10)
      .where((q) => q.where("teamId", 1).orWhere("teamId", null));
    assert.deepEqual(query.toSql(), {
      sql: 'select * from "users" where ("is_admin" = $1 and "votes" >= $2 and ("team_id" = $3 or "team_id" is null))',
      parameters: [true, 10, 1],
    });
    assert.equal(
      User.on(db).where({ teamId: 1, isAdmin: false }).toSql().sql,
      'select * from "users" where ("team_id" = $1 and "is_admin" = $2)'
    );
  });

  it("uses a model query as a subquery, with its global scopes", () => {
    const authors = Post.on(db).select("userId").where("published", true);
    assert.equal(
      User.on(db).whereIn("id", authors).toSql().sql,
      'select * from "users" where "id" in (select "user_id" from "posts" where ("published" = $1 and "posts"."deleted_at" is null))'
    );
  });

  it("explains a callback or scope that forgot to return the query", () => {
    assert.throws(() => User.on(db).where((q) => { q.where("a", 1); }), /must return the query/);
    assert.throws(() => User.on(db).apply(() => {}), /must return the query/);
    assert.throws(() => User.on(db).when(true, () => {}), /must return the query/);
  });

  it("refuses, in strict mode, a fill key that fillable would drop", () => {
    assert.throws(() => new User({ name: "ada", role: "admin" }), (error) => {
      assert.ok(error instanceof MassAssignmentError);
      assert.match(error.message, /"role" is not fillable on User/);
      return true;
    });
    class Lenient extends User {
      static strict = false;
    }
    const lenient = new Lenient({ name: "ada", role: "admin" });
    assert.deepEqual(lenient.getAttributes(), { name: "ada" });
    // forceFill and direct assignment are not mass assignment.
    assert.equal(new User().forceFill({ role: "admin" }).role, "admin");
  });

  it("refuses mass assignment on a model without fillable, strict or not", () => {
    class Locked extends Model {
      static strict = false;
    }
    assert.throws(() => Locked.make({ name: "ada" }), /allows no mass assignment/);
    class Open extends Model {
      static guarded = ["isAdmin"];
    }
    assert.deepEqual(Open.make({ name: "ada" }).getAttributes(), { name: "ada" });
    assert.throws(() => Open.make({ isAdmin: true }), /"isAdmin" is not fillable/);
  });

  it("refuses an attribute that would hide a method or getter", () => {
    class Named extends Model {
      static guarded = [];
      get label() {
        return "x";
      }
    }
    assert.throws(() => Named.make({ save: 1 }), /"save" cannot be an attribute of Named/);
    assert.throws(() => Named.make({ label: 1 }), /"label" cannot be an attribute of Named/);
  });

  it("throws reading a relation that was not loaded, in strict mode", () => {
    const user = new User();
    assert.throws(() => user.getRelation("posts"), (error) => error instanceof RelationNotLoadedError && /User\.posts is not loaded/.test(error.message));
    user.setRelation("posts", [new Post({ title: "a" })]);
    assert.equal(user.relationLoaded("posts"), true);
    assert.deepEqual(user.toJSON().posts, [{ title: "a" }]);
    // Relations are not attributes, so they are never saved as columns.
    assert.deepEqual(Object.keys(user), []);
    class Lenient extends User {
      static strict = false;
    }
    assert.equal(new Lenient().getRelation("posts"), undefined);
  });

  it("refuses an unknown cast", () => {
    class Odd extends Model {
      static casts = { flag: "bool" };
    }
    assert.throws(() => Odd.on(db).toSql(), /unknown cast "bool" for Odd\.flag/);
  });

  it("explains a model without a connection", () => {
    assert.throws(() => User.query(), /User has no connection\. Pass one with User\.on\(db\)/);
    setConnectionResolver((name) => (name === "base" ? db : undefined));
    class Tenant extends Model {
      static connection = "tenant";
    }
    assert.throws(() => Tenant.query(), /no connection named "tenant" for Tenant/);
    class Base extends Model {
      static connection = "base";
    }
    assert.equal(Base.query().connection, db);
  });

  it("serializes with hidden, visible and appends", () => {
    class Shown extends Model {
      static guarded = [];
      static hidden = ["password"];
      static appends = ["label"];
      get label() {
        return `${this.name} <${this.email}>`;
      }
    }
    const shown = Shown.make({ name: "ada", email: "a@x", password: "secret" });
    assert.deepEqual(JSON.parse(JSON.stringify(shown)), { name: "ada", email: "a@x", label: "ada <a@x>" });
    class Only extends Shown {
      static visible = ["name"];
    }
    assert.deepEqual(Only.make({ name: "ada", email: "a@x" }).toJSON(), { name: "ada" });
  });
});

const DDL = {
  postgres: [
    "create table users (id serial primary key, name varchar(100) not null, email varchar(100) not null unique, is_admin boolean not null default false, settings jsonb null, born_on date null, last_seen_at timestamp(3) null, votes integer not null default 0, team_id integer null, created_at timestamp null, updated_at timestamp null)",
    "create table posts (id serial primary key, user_id integer null, title varchar(100) not null, published boolean not null default false, created_at timestamp null, updated_at timestamp null, deleted_at timestamp null)",
    "create table audits (id serial primary key, event varchar(50) not null, subject varchar(100) null)",
    "create table tags (code varchar(50) primary key, label varchar(100) not null)",
  ],
  mysql: [
    "create table users (id int auto_increment primary key, name varchar(100) not null, email varchar(100) not null unique, is_admin tinyint(1) not null default 0, settings json null, born_on date null, last_seen_at datetime(3) null, votes int not null default 0, team_id int null, created_at datetime null, updated_at datetime null) engine=InnoDB",
    "create table posts (id int auto_increment primary key, user_id int null, title varchar(100) not null, published tinyint(1) not null default 0, created_at datetime null, updated_at datetime null, deleted_at datetime null) engine=InnoDB",
    "create table audits (id int auto_increment primary key, event varchar(50) not null, subject varchar(100) null) engine=InnoDB",
    "create table tags (code varchar(50) primary key, label varchar(100) not null) engine=InnoDB",
  ],
  sqlite: [
    "create table users (id integer primary key autoincrement, name varchar(100) not null, email varchar(100) not null unique, is_admin boolean not null default 0, settings text null, born_on date null, last_seen_at datetime null, votes integer not null default 0, team_id integer null, created_at datetime null, updated_at datetime null)",
    "create table posts (id integer primary key autoincrement, user_id integer null, title varchar(100) not null, published boolean not null default 0, created_at datetime null, updated_at datetime null, deleted_at datetime null)",
    "create table audits (id integer primary key autoincrement, event varchar(50) not null, subject varchar(100) null)",
    "create table tags (code varchar(50) primary key, label varchar(100) not null)",
  ],
  mssql: [
    "create table users (id int identity(1,1) primary key, name nvarchar(100) not null, email nvarchar(100) not null unique, is_admin bit not null default 0, settings nvarchar(max) null, born_on date null, last_seen_at datetime2(3) null, votes int not null default 0, team_id int null, created_at datetime2 null, updated_at datetime2 null)",
    "create table posts (id int identity(1,1) primary key, user_id int null, title nvarchar(100) not null, published bit not null default 0, created_at datetime2 null, updated_at datetime2 null, deleted_at datetime2 null)",
    "create table audits (id int identity(1,1) primary key, event nvarchar(50) not null, subject nvarchar(100) null)",
    "create table tags (code nvarchar(50) primary key, label nvarchar(100) not null)",
  ],
};
DDL.mariadb = DDL.mysql;

const DIALECT = { "better-sqlite3": "sqlite", postgres: "postgres", mysql: "mysql", mariadb: "mariadb", mssql: "mssql" };
const ORM_CLIENT = { postgres: "pg", mysql: "mysql2", mariadb: "mariadb", mssql: "mssql" };
const NOT_YET = { sqlite3: "the sqlite3 driver is dropped in 1.0" };

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

describe("models against a real database", () => {
  for (const engine of loadEngines()) {
    const skip = engine.skip || NOT_YET[engine.id] || false;
    describe(engine.label, { skip }, () => {
      const isSqlite = engine.id === "better-sqlite3";
      const dialect = DIALECT[engine.id];
      const database = `tenora_model_${randomBytes(3).toString("hex")}`;
      const sqliteDir = isSqlite ? fs.mkdtempSync(path.join(os.tmpdir(), "tenora-model-")) : undefined;
      let admin;
      let db;
      const subclasses = [];

      /** A model of an existing table with its own listeners, so tests do not share them. */
      const variant = (base, statics = {}) => {
        const model = class extends base {};
        Object.defineProperty(model, "name", { value: `${base.name}Variant` });
        Object.assign(model, { table: base.getTable(), ...statics });
        subclasses.push(model);
        return model;
      };

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
          db = createConnection({ ...serverConfig(engine, database), pool: { max: 5, acquireTimeoutMillis: 5_000 } });
        }
        for (const statement of DDL[dialect]) await db.raw(sql`${sql.raw(statement)}`);
      });

      beforeEach(() => setConnectionResolver(() => db));

      afterEach(async () => {
        setConnectionResolver(() => db);
        for (const model of [...MODELS, ...subclasses.splice(0)]) model.flushEventListeners();
        for (const table of ["users", "posts", "audits", "tags"]) await db.table(table).delete();
      });

      after(async () => {
        setConnectionResolver(undefined);
        await db?.destroy();
        if (admin) {
          await engine.cleanup(admin, { databases: [database], users: [] });
          await admin.destroy();
        }
        if (sqliteDir) fs.rmSync(sqliteDir, { recursive: true, force: true });
      });

      const raw = (table, id) => db.table(table).where("id", id).first();

      describe("saving and reading", () => {
        it("creates, finds, updates only the changed columns, and deletes", async () => {
          const ada = await User.create({ name: "ada", email: "ada@x", votes: 1 });
          assert.equal(typeof ada.id, "number");
          assert.equal(ada.exists, true);
          assert.equal(ada.wasRecentlyCreated, true);
          assert.ok(ada.createdAt instanceof Date);
          assert.equal(ada.createdAt.getTime(), ada.updatedAt.getTime());
          assert.equal(ada.isDirty(), false);

          const found = await User.find(ada.id);
          assert.ok(found instanceof User);
          assert.equal(found.wasRecentlyCreated, false);
          assert.equal(found.name, "ada");
          assert.equal(found.createdAt.getTime(), ada.createdAt.getTime());

          // A column changed behind the model's back stays as it is: save() writes only what changed.
          await db.table("users").where("id", ada.id).update({ votes: 5 });
          found.name = "Ada";
          assert.deepEqual(Object.keys(found.getDirty()), ["name"]);
          assert.equal(await found.save(), true);
          assert.ok("name" in found.getChanges());
          assert.ok(!("votes" in found.getChanges()));
          assert.equal(found.wasChanged("name"), true);
          assert.equal(found.wasChanged("votes"), false);
          const row = await raw("users", ada.id);
          assert.equal(row.name, "Ada");
          assert.equal(row.votes, 5);

          // Nothing changed: no query, and saved still fires.
          assert.equal(await found.save(), true);

          assert.equal(await found.update({ votes: 7 }), true);
          assert.equal((await raw("users", ada.id)).votes, 7);

          assert.equal(await found.delete(), true);
          assert.equal(found.exists, false);
          assert.equal(await User.find(ada.id), undefined);
        });

        it("round-trips casts: booleans, JSON, dates and datetimes", async () => {
          const seen = new Date("2026-03-04T05:06:07.890Z");
          const settings = { theme: "dark", tabs: [1, 2], nested: { on: true, off: null } };
          const user = await User.create({
            name: "ada",
            email: "ada@x",
            isAdmin: true,
            settings,
            bornOn: "1990-05-17",
            lastSeenAt: seen,
          });
          const loaded = await User.findOrFail(user.id);
          assert.equal(loaded.isAdmin, true);
          assert.deepEqual(loaded.settings, settings);
          assert.equal(loaded.bornOn, "1990-05-17");
          assert.ok(loaded.lastSeenAt instanceof Date);
          assert.equal(loaded.lastSeenAt.getTime(), seen.getTime());
          assert.equal(loaded.isClean(), true);
          assert.equal((await user.refresh()).isClean(), true);
          assert.equal(user.lastSeenAt.getTime(), seen.getTime());

          // What the database holds without the casts.
          const row = await raw("users", user.id);
          if (dialect === "sqlite") {
            assert.equal(row.is_admin, 1);
            assert.equal(row.last_seen_at, seen.getTime());
            assert.equal(row.born_on, "1990-05-17");
            assert.equal(typeof row.settings, "string");
          }
          if (dialect === "mssql") {
            assert.equal(row.is_admin, true);
            assert.ok(row.born_on instanceof Date);
          }

          loaded.isAdmin = false;
          loaded.bornOn = new Date(2001, 0, 2);
          loaded.settings = { theme: "light" };
          loaded.lastSeenAt = null;
          await loaded.save();
          const again = await User.find(user.id);
          assert.equal(again.isAdmin, false);
          assert.equal(again.bornOn, "2001-01-02");
          assert.deepEqual(again.settings, { theme: "light" });
          assert.equal(again.lastSeenAt, null);

          const admins = await User.where("isAdmin", false).pluck("isAdmin");
          assert.deepEqual(admins, [false]);
        });

        it("tracks changes by cast value, JSON by content and in-place edits", async () => {
          const user = await User.create({ name: "ada", email: "ada@x", isAdmin: false, settings: { a: 1, b: [1] } });
          user.isAdmin = 0;
          assert.equal(user.isDirty("isAdmin"), false);
          user.settings = { b: [1], a: 1 };
          assert.equal(user.isDirty("settings"), false);
          user.settings.b.push(2);
          assert.equal(user.isDirty("settings"), true);
          assert.deepEqual(user.getOriginal("settings"), { a: 1, b: [1] });
          assert.equal(user.isDirty(["name", "email"]), false);
          assert.equal(user.isClean("name"), true);
          await user.save();
          assert.deepEqual((await User.find(user.id)).settings, { a: 1, b: [1, 2] });
          assert.equal(user.isClean(), true);
          assert.deepEqual(user.getOriginal("settings"), { a: 1, b: [1, 2] });
        });

        it("sets timestamps, and touch() moves updatedAt", async () => {
          const user = await User.create({ name: "ada", email: "ada@x" });
          const created = user.createdAt.getTime();
          await db.table("users").where("id", user.id).update({ updated_at: new Date(2000, 0, 1) });
          await user.refresh();
          assert.equal(user.updatedAt.getFullYear(), 2000);
          assert.equal(await user.touch(), true);
          assert.ok(user.updatedAt.getTime() >= created);
          assert.equal((await User.find(user.id)).updatedAt.getTime(), user.updatedAt.getTime());
          assert.equal(user.createdAt.getTime(), created);
          // A model without timestamps has none to touch.
          const tag = await Tag.create({ code: "a", label: "A" });
          assert.equal(await tag.touch(), false);
          assert.equal("createdAt" in tag, false);
        });

        it("uses a key the database does not generate", async () => {
          const tag = await Tag.create({ code: "red", label: "Red" });
          assert.equal(tag.code, "red");
          tag.label = "Crimson";
          await tag.save();
          assert.equal((await Tag.findOrFail("red")).label, "Crimson");
          tag.code = "crimson";
          await tag.save(); // updates the row it was read as, by its original key
          assert.deepEqual(await Tag.pluck("code"), ["crimson"]);
          await tag.delete();
          assert.equal(await Tag.count(), 0);
        });

        it("reads and writes with the database's column names when naming is turned off", async () => {
          const user = await RawUser.create({ name: "ada", email: "ada@x", is_admin: true });
          assert.ok(user.created_at instanceof Date);
          const loaded = await RawUser.where("is_admin", true).first();
          assert.equal(loaded.name, "ada");
          assert.ok("team_id" in loaded);
        });

        it("refreshes, and returns a fresh copy", async () => {
          const user = await User.create({ name: "ada", email: "ada@x" });
          await db.table("users").where("id", user.id).update({ name: "changed" });
          const copy = await user.fresh();
          assert.equal(copy.name, "changed");
          assert.equal(user.name, "ada");
          await user.refresh();
          assert.equal(user.name, "changed");
          await db.table("users").where("id", user.id).delete();
          await assert.rejects(user.refresh(), ModelNotFoundError);
        });
      });

      describe("queries", () => {
        const seed = async () => {
          const rows = [
            ["ada", true, 30, 1],
            ["bob", false, 10, 1],
            ["cy", true, 20, 2],
            ["dee", false, 5, null],
          ];
          for (const [name, isAdmin, votes, teamId] of rows) {
            await User.create({ name, email: `${name}@x`, isAdmin, votes, teamId });
          }
        };

        it("finds by key, many keys, or fails", async () => {
          await seed();
          const ids = await User.orderBy("name").pluck("id");
          assert.equal((await User.find(ids[1])).name, "bob");
          assert.deepEqual((await User.findMany([ids[0], ids[2]])).map((u) => u.name).sort(), ["ada", "cy"]);
          assert.deepEqual((await User.find([ids[3]])).map((u) => u.name), ["dee"]);
          assert.deepEqual(await User.findMany([]), []);
          await assert.rejects(User.findOrFail(-1), (error) => {
            assert.ok(error instanceof ModelNotFoundError);
            assert.match(error.message, /no User with key -1/);
            assert.deepEqual(error.ids, [-1]);
            return true;
          });
          await assert.rejects(User.findOrFail([ids[0], -2]), (error) => error.ids.length === 1 && error.ids[0] === -2);
          await assert.rejects(User.where("name", "nobody").firstOrFail(), /no User matches the query/);
          // find() keeps the query's own conditions together: (a or b) and id = ?
          assert.equal(await User.where("name", "bob").orWhere("name", "cy").find(ids[0]), undefined);
        });

        it("filters, orders, counts and plucks with attribute names", async () => {
          await seed();
          assert.deepEqual(await User.query().apply(User.active).orderBy("votes").pluck("name"), ["cy", "ada"]);
          assert.deepEqual(await User.query().apply(User.withVotes, 20).orderByDesc("votes").pluck("name"), ["ada", "cy"]);
          assert.equal(await User.where("teamId", 1).count(), 2);
          assert.equal(await User.whereNull("teamId").count(), 1);
          assert.equal(await User.where("votes", ">", 100).exists(), false);
          assert.deepEqual(
            await User.where((q) => q.where("teamId", 2).orWhere("votes", "<", 10)).orderBy("name").pluck("name"),
            ["cy", "dee"]
          );
          assert.deepEqual(await User.where({ teamId: 1, isAdmin: false }).pluck("name"), ["bob"]);
          assert.equal(await User.query().sum("votes"), 65);
          const names = (await User.query().when("b", (q, prefix) => q.where("name", "like", `${prefix}%`))).map((u) => u.name);
          assert.deepEqual(names, ["bob"]);
          assert.deepEqual((await User.all()).length, 4);
          const first = await User.oldest("votes").first();
          assert.equal(first.name, "dee");
          const partial = await User.select("id", "name").where("name", "ada").first();
          assert.deepEqual(Object.keys(partial).sort(), ["id", "name"]);
          // Rows of another model as a subquery: users who wrote a published post.
          const [ada] = await User.where("name", "ada").get();
          await Post.create({ userId: ada.id, title: "hi", published: true });
          assert.deepEqual(await User.whereIn("id", Post.query().select("userId").where("published", true)).pluck("name"), ["ada"]);
        });

        it("paginates", async () => {
          await seed();
          const page = await User.query().orderBy("name").paginate({ page: 2, perPage: 3 });
          assert.deepEqual(
            { ...page, data: page.data.map((u) => u.name) },
            { data: ["dee"], total: 4, page: 2, perPage: 3, lastPage: 2 }
          );
          const empty = await User.where("name", "nobody").paginate();
          assert.deepEqual({ ...empty, data: empty.data.length }, { data: 0, total: 0, page: 1, perPage: 15, lastPage: 1 });
          await assert.rejects(User.query().paginate({ page: 0 }), /counts pages from 1/);
        });

        it("chunks by key, and reads lazily", async () => {
          for (let i = 1; i <= 7; i++) await User.create({ name: `u${i}`, email: `u${i}@x`, votes: i });
          const pages = [];
          const result = await User.where("votes", ">", 0).chunkById(3, async (users, page) => {
            pages.push([page, users.map((u) => u.votes)]);
            // Deleting what was read does not shift the next chunk.
            for (const user of users) await user.delete();
          });
          assert.equal(result, true);
          assert.deepEqual(pages, [[1, [1, 2, 3]], [2, [4, 5, 6]], [3, [7]]]);

          for (let i = 1; i <= 5; i++) await User.create({ name: `v${i}`, email: `v${i}@x`, votes: i });
          let calls = 0;
          assert.equal(await User.query().chunkById(2, () => (calls++, false)), false);
          assert.equal(calls, 1);

          const seen = [];
          for await (const user of User.where("votes", ">=", 2).orWhere("name", "v1").lazyById(2)) seen.push(user.name);
          assert.deepEqual(seen, ["v1", "v2", "v3", "v4", "v5"]);
          await assert.rejects(User.orderBy("name").chunkById(2, () => {}), /orders and pages by the key itself/);
        });

        it("updates and deletes in bulk, setting updatedAt, without model events", async () => {
          await seed();
          const Watched = variant(User);
          const fired = [];
          for (const event of MODEL_EVENTS) Watched[event]((user) => void fired.push(event));
          await db.table("users").update({ updated_at: new Date(2000, 0, 1) });
          assert.equal(await Watched.where("teamId", 1).update({ votes: 0, settings: { bulk: true } }), 2);
          assert.equal(await Watched.where("votes", 0).increment("votes", 2), 2);
          const bob = await User.where("name", "bob").first();
          assert.equal(bob.votes, 2);
          assert.deepEqual(bob.settings, { bulk: true });
          assert.ok(bob.updatedAt.getFullYear() > 2000);
          assert.equal(await Watched.where("teamId", 2).delete(), 1);
          assert.deepEqual(fired, []);
          assert.equal(await User.count(), 3);
          await assert.rejects(User.query().limit(1).delete(), /ignores limit/);
        });

        it("upserts with attribute names and timestamps", async () => {
          await User.query().upsert(
            [
              { email: "ada@x", name: "Ada", votes: 1 },
              { email: "bob@x", name: "Bob", votes: 2 },
            ],
            "email"
          );
          await User.query().upsert([{ email: "ada@x", name: "Ada L.", votes: 9 }], "email", ["name"]);
          const ada = await User.where("email", "ada@x").first();
          assert.equal(ada.name, "Ada L.");
          assert.equal(ada.votes, 1);
          assert.ok(ada.createdAt instanceof Date);
          assert.equal(await User.count(), 2);
        });

        it("destroys by key, firing events", async () => {
          await seed();
          const Watched = variant(User);
          const deleted = [];
          Watched.deleted((user) => void deleted.push(user.name));
          const ids = await User.whereIn("name", ["ada", "bob"]).pluck("id");
          assert.equal(await Watched.destroy(ids), 2);
          assert.deepEqual(deleted.sort(), ["ada", "bob"]);
        });
      });

      describe("connections", () => {
        it("remembers the database an instance came from", async () => {
          const user = await User.create({ name: "ada", email: "ada@x" });
          setConnectionResolver(() => undefined);
          assert.throws(() => User.query(), /no connection named "default" for User/);
          user.name = "Ada";
          await user.save();
          setConnectionResolver(undefined);
          assert.throws(() => User.query(), /User has no connection/);
          const loaded = await User.on(db).find(user.id);
          assert.equal(loaded.name, "Ada");
          await loaded.delete();
          assert.equal(await User.on(db).count(), 0);
          const made = User.on(db).make({ name: "bob", email: "bob@x" });
          await made.save();
          assert.equal(await User.on(db).count(), 1);
        });

        it("runs in an explicit transaction with using(), events included", async () => {
          const Watched = variant(User);
          Watched.saved((user) => Audit.create({ event: "saved", subject: user.name }).then(() => undefined));
          const ada = await User.create({ name: "ada", email: "ada@x" });

          const trx = await db.beginTransaction();
          await Watched.using(trx).create({ name: "bob", email: "bob@x" });
          assert.equal(await Watched.using(trx).count(), 2);
          assert.equal(await Audit.using(trx).count(), 1);
          const pinned = (await Watched.using(trx).find(ada.id)).using(trx);
          pinned.name = "changed";
          await pinned.save();
          assert.equal(await Audit.using(trx).count(), 2);
          await trx.rollback();

          assert.equal(await User.count(), 1);
          assert.equal(await Audit.count(), 0);
          assert.equal((await User.find(ada.id)).name, "ada");
          // A pinned instance stays pinned: after the rollback its writes fail instead of escaping the transaction.
          pinned.name = "again";
          await assert.rejects(pinned.save(), /already committed or rolled back/);
          pinned.using(undefined);
          pinned.name = "ada";
          await pinned.save();
        });

        it("joins the ambient transaction, events included, and rolls back with it", async () => {
          const Watched = variant(User);
          Watched.created((user) => Audit.create({ event: "created", subject: user.name }).then(() => undefined));
          await assert.rejects(
            db.transaction(async () => {
              await Watched.create({ name: "ada", email: "ada@x" });
              assert.equal(await Audit.count(), 1);
              throw new Error("roll back");
            }),
            /roll back/
          );
          assert.equal(await User.count(), 0);
          assert.equal(await Audit.count(), 0);

          // Loaded before the transaction, saved inside it: the save joins it.
          const ada = await User.create({ name: "ada", email: "ada@x" });
          await assert.rejects(
            db.transaction(async () => {
              ada.name = "changed";
              await ada.save();
              throw new Error("roll back");
            })
          );
          assert.equal((await User.find(ada.id)).name, "ada");
        });
      });

      describe("events and observers", () => {
        it("fires events in Eloquent's order", async () => {
          const Watched = variant(User);
          const fired = [];
          for (const event of MODEL_EVENTS) Watched[event]((user) => void fired.push(event));
          const user = await Watched.create({ name: "ada", email: "ada@x" });
          assert.deepEqual(fired.splice(0), ["saving", "creating", "created", "saved"]);
          user.name = "Ada";
          await user.save();
          assert.deepEqual(fired.splice(0), ["saving", "updating", "updated", "saved"]);
          await user.save();
          assert.deepEqual(fired.splice(0), ["saving", "saved"]);
          await Watched.find(user.id);
          assert.deepEqual(fired.splice(0), ["retrieved"]);
          await user.delete();
          assert.deepEqual(fired.splice(0), ["deleting", "deleted"]);
        });

        it("lets a listener change the model before it is written, or cancel the write", async () => {
          const Watched = variant(User);
          Watched.creating((user) => {
            user.email = user.email.toLowerCase();
          });
          Watched.saving((user) => (user.name === "nobody" ? false : undefined));
          Watched.deleting((user) => !user.isAdmin);
          const ada = await Watched.create({ name: "ada", email: "ADA@X", isAdmin: true });
          assert.equal((await raw("users", ada.id)).email, "ada@x");

          const nobody = await Watched.create({ name: "nobody", email: "n@x" });
          assert.equal(nobody.exists, false);
          assert.equal(await User.count(), 1);

          ada.name = "nobody";
          assert.equal(await ada.save(), false);
          assert.equal((await raw("users", ada.id)).name, "ada");
          assert.equal(await ada.delete(), false);
          assert.equal(await User.count(), 1);
        });

        it("runs afterCommit observers only after the transaction commits", async () => {
          const Watched = variant(User);
          const calls = [];
          Watched.observe({
            afterCommit: true,
            creating: (user) => void calls.push(`creating ${user.name}`),
            created: (user) => void calls.push(`created ${user.name}`),
          });
          class Counter {
            static afterCommit = true;
            saved(user) {
              calls.push(`saved ${user.name}`);
            }
          }
          Watched.observe(Counter);

          await db.transaction(async () => {
            await Watched.create({ name: "ada", email: "ada@x" });
            // The "before" event ran; the others wait for the commit.
            assert.deepEqual(calls, ["creating ada"]);
          });
          assert.deepEqual(calls.splice(0), ["creating ada", "created ada", "saved ada"]);

          await assert.rejects(
            db.transaction(async () => {
              await Watched.create({ name: "bob", email: "bob@x" });
              throw new Error("roll back");
            })
          );
          assert.deepEqual(calls.splice(0), ["creating bob"]);

          // A savepoint that rolls back drops its callbacks; the outer transaction keeps its own.
          await db.transaction(async () => {
            await Watched.create({ name: "cy", email: "cy@x" });
            await assert.rejects(
              db.transaction(async () => {
                await Watched.create({ name: "dee", email: "dee@x" });
                throw new Error("inner");
              })
            );
          });
          assert.deepEqual(calls.splice(0), ["creating cy", "creating dee", "created cy", "saved cy"]);

          // Outside a transaction they run straight away.
          await Watched.create({ name: "eve", email: "eve@x" });
          assert.deepEqual(calls.splice(0), ["creating eve", "created eve", "saved eve"]);
        });
      });

      describe("soft deletes", () => {
        it("hides deleted rows, and restores or force-deletes them", async () => {
          const Watched = variant(Post);
          const fired = [];
          for (const event of MODEL_EVENTS) Watched[event](() => void fired.push(event));
          const post = await Watched.create({ title: "a" });
          const other = await Post.create({ title: "b" });
          fired.length = 0;

          assert.equal(await post.delete(), true);
          assert.deepEqual(fired.splice(0), ["deleting", "deleted"]);
          assert.equal(post.trashed(), true);
          assert.equal(post.exists, true);
          assert.ok((await raw("posts", post.id)).deleted_at);
          assert.deepEqual(await Post.pluck("title"), ["b"]);
          assert.deepEqual(await Post.withTrashed().orderBy("title").pluck("title"), ["a", "b"]);
          assert.deepEqual(await Post.onlyTrashed().pluck("title"), ["a"]);
          assert.equal(await Post.find(post.id), undefined);
          // or-conditions stay inside: deleted rows remain hidden.
          assert.deepEqual(await Post.where("title", "a").orWhere("title", "b").pluck("title"), ["b"]);

          assert.equal(await post.restore(), true);
          assert.deepEqual(fired.splice(0), ["restoring", "saving", "updating", "updated", "saved", "restored"]);
          assert.equal(post.trashed(), false);
          assert.equal(await Post.count(), 2);

          assert.equal(await post.forceDelete(), true);
          assert.deepEqual(fired.splice(0), ["forceDeleting", "deleting", "deleted", "forceDeleted"]);
          assert.equal(post.exists, false);
          assert.equal(await Post.withTrashed().count(), 1);

          await other.delete();
          assert.equal(await Post.count(), 0);
          const trashed = await Post.withTrashed().firstOrFail();
          assert.equal(trashed.trashed(), true);
        });

        it("soft-deletes, restores and force-deletes in bulk", async () => {
          for (const title of ["a", "b", "c"]) await Post.create({ title });
          assert.equal(await Post.whereIn("title", ["a", "b"]).delete(), 2);
          assert.equal(await Post.count(), 1);
          assert.equal(await Post.withTrashed().count(), 3);
          assert.equal(await Post.onlyTrashed().where("title", "a").restore(), 1);
          assert.deepEqual(await Post.orderBy("title").pluck("title"), ["a", "c"]);
          assert.equal(await Post.where("title", "b").forceDelete(), 1);
          assert.equal(await Post.withTrashed().count(), 2);
        });
      });

      describe("scopes", () => {
        it("applies global scopes, which withoutGlobalScope leaves out", async () => {
          const Published = variant(Post, { globalScopes: { published: (query) => query.where("published", true) } });
          const Recent = variant(Post);
          Recent.addGlobalScope("titled", (query) => query.where("title", "!=", "untitled"));
          await Post.create({ title: "a", published: true });
          await Post.create({ title: "b", published: false });
          await Post.create({ title: "untitled", published: true });
          assert.deepEqual(await Published.orderBy("title").pluck("title"), ["a", "untitled"]);
          assert.deepEqual(await Published.withoutGlobalScope("published").orderBy("title").pluck("title"), ["a", "b", "untitled"]);
          assert.equal(await Published.where("title", "b").orWhere("title", "untitled").count(), 1);
          assert.deepEqual(await Recent.orderBy("title").pluck("title"), ["a", "b"]);
          // A scope on a parent applies to models that extend it.
          const Child = variant(Recent);
          assert.equal(await Child.count(), 2);
        });
      });

      describe("first or create", () => {
        it("finds, creates, and updates or creates", async () => {
          const first = await User.firstOrCreate({ email: "ada@x" }, { name: "ada" });
          assert.equal(first.wasRecentlyCreated, true);
          const again = await User.firstOrCreate({ email: "ada@x" }, { name: "other" });
          assert.equal(again.id, first.id);
          assert.equal(again.name, "ada");

          const updated = await User.updateOrCreate({ email: "ada@x" }, { name: "Ada" });
          assert.equal(updated.id, first.id);
          assert.equal((await User.find(first.id)).name, "Ada");
          const created = await User.updateOrCreate({ email: "bob@x" }, { name: "bob" });
          assert.equal(created.wasRecentlyCreated, true);

          const fresh = await User.firstOrNew({ email: "cy@x" }, { name: "cy" });
          assert.equal(fresh.exists, false);
          assert.equal(fresh.name, "cy");
          assert.equal(await User.count(), 2);
        });

        it("returns the existing row on a unique violation, and keeps the transaction usable", async () => {
          const ada = await User.create({ name: "ada", email: "ada@x" });
          const existing = await User.createOrFirst({ email: "ada@x" }, { name: "other" });
          assert.equal(existing.id, ada.id);
          assert.equal(existing.wasRecentlyCreated, false);

          await db.transaction(async () => {
            const inside = await User.createOrFirst({ email: "ada@x" }, { name: "other" });
            assert.equal(inside.id, ada.id);
            // Postgres would refuse every further statement had the insert not run in a savepoint.
            await User.create({ name: "bob", email: "bob@x" });
            const cy = await User.createOrFirst({ email: "cy@x" }, { name: "cy" });
            assert.equal(cy.wasRecentlyCreated, true);
          });
          assert.equal(await User.count(), 3);

          const trx = await db.beginTransaction();
          const viaHandle = await User.using(trx).createOrFirst({ email: "ada@x" }, { name: "other" });
          assert.equal(viaHandle.id, ada.id);
          await User.using(trx).create({ name: "dee", email: "dee@x" });
          await trx.commit();
          assert.equal(await User.count(), 4);
        });
      });

      describe("strict mode", () => {
        it("refuses unknown fill keys before anything is written", async () => {
          await assert.rejects(User.create({ name: "ada", email: "ada@x", role: "admin" }), MassAssignmentError);
          assert.equal(await User.count(), 0);
          const user = await User.create({ name: "ada", email: "ada@x" });
          assert.throws(() => user.fill({ id: 5 }), /"id" is not fillable on User/);
          await assert.rejects(user.update({ password: "x" }), MassAssignmentError);
        });

        it("refuses a column whose attribute would hide a method", async () => {
          await User.create({ name: "ada", email: "ada@x" });
          await assert.rejects(User.query().select("name as save").get(), /"save" cannot be an attribute of User/);
        });
      });
    });
  }
});
