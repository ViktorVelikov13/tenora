import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import knex from "knex";
import {
  createConnection,
  createMigrator,
  createSeeder,
  listMigrationFiles,
  MigrationError,
  MigrationLockError,
  SeedError,
  sql,
} from "../packages/orm/dist/index.js";
import { loadEngines } from "./support/engines.mjs";

// Migration files written by the tests import the ORM by absolute path: they live in temporary directories, outside
// any node_modules.
const ORM_PATH = fileURLToPath(new URL("../packages/orm/dist/index.js", import.meta.url));
const ORM_URL = pathToFileURL(ORM_PATH).href;

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

// import() caches modules by path for the life of the process, so every test writes its files into a new directory
// and never rewrites a file it has already run.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tenora-migrations-"));
let folders = 0;
const folder = (files = {}) => {
  const dir = path.join(scratch, `files${++folders}`);
  fs.mkdirSync(dir);
  addFiles(dir, files);
  return dir;
};
const addFiles = (dir, files) => {
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), source);
};

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const DIALECT = { "better-sqlite3": "sqlite", postgres: "postgres", mysql: "mysql", mariadb: "mariadb", mssql: "mssql" };
const ORM_CLIENT = { postgres: "pg", mysql: "mysql2", mariadb: "mariadb", mssql: "mssql" };
const NOT_YET = { sqlite3: "the sqlite3 driver is dropped in 1.0" };

/** Each dialect's DDL for a small table, as a migration would write it by hand. */
const CREATE = {
  postgres: (table) => `create table ${table} (id integer primary key, label varchar(50))`,
  mysql: (table) => `create table ${table} (id int primary key, label varchar(50)) engine=InnoDB`,
  mariadb: (table) => `create table ${table} (id int primary key, label varchar(50)) engine=InnoDB`,
  sqlite: (table) => `create table ${table} (id integer primary key, label varchar(50))`,
  mssql: (table) => `create table ${table} (id int primary key, label nvarchar(50))`,
};

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

/** Sources of migration and seed files in each format the migrator accepts. */
const sources = (dialect) => {
  const raw = (statement) => "await db.raw(sql`" + statement + "`);";
  const create = (table) => raw(CREATE[dialect](table));
  const drop = (table) => raw(`drop table ${table}`);
  const esmImport = `import { migration, seed, sql } from ${JSON.stringify(ORM_URL)};\n`;
  const cjsRequire = `const { migration, sql } = require(${JSON.stringify(ORM_PATH)});\n`;

  return {
    /** ESM, with migration() */
    table: (table) =>
      `${esmImport}export default migration({
  async up({ db }) { ${create(table)} },
  async down({ db }) { ${drop(table)} },
});\n`,
    /** CommonJS, plain exports */
    cjsTable: (table) =>
      `${cjsRequire}exports.up = async ({ db }) => { ${create(table)} };
exports.down = async ({ db }) => { ${drop(table)} };\n`,
    /** CommonJS, module.exports = migration(…) */
    cjsMigration: (table) =>
      `${cjsRequire}module.exports = migration({
  up: async ({ db }) => { ${create(table)} },
  down: async ({ db }) => { ${drop(table)} },
});\n`,
    /** ESM, named exports; changes data with the query builder */
    fill: (table, id) =>
      `export async function up({ db }) { await db.table(${JSON.stringify(table)}).insert({ id: ${id}, label: "filled" }); }
export async function down({ db }) { await db.table(${JSON.stringify(table)}).where("id", ${id}).delete(); }\n`,
    /** TypeScript, with types Node strips */
    typed: (table) =>
      `import { sql } from ${JSON.stringify(ORM_URL)};
import type { MigrationContext } from ${JSON.stringify(ORM_URL)};

interface Row { id: number; label: string }
const row: Row = { id: 1, label: "typed" };

export async function up({ db }: MigrationContext): Promise<void> {
  ${create(table)}
  await db.table(${JSON.stringify(table)}).insert(row);
}
export const down = async ({ db }: MigrationContext): Promise<void> => { ${drop(table)} };\n`,
    /** writes to ctx.log, which the test passes in through the context option */
    logged: (name, table) =>
      `${esmImport}export default migration({
  async up({ db, log }) { log.push("up ${name}"); ${create(table)} },
  async down({ db, log }) { log.push("down ${name}"); ${drop(table)} },
});\n`,
    /** creates a table, writes a row, then throws */
    broken: (table) =>
      `${esmImport}export default migration({
  async up({ db }) {
    ${create(table)}
    await db.table(${JSON.stringify(table)}).insert({ id: 1, label: "half done" });
    throw new Error("broken on purpose");
  },
  async down() {},
});\n`,
    /** waits for the test, outside a transaction, so another migrator can try its luck meanwhile */
    waiting: (table) =>
      `${esmImport}export default migration({
  transaction: false,
  async up({ db, started, gate }) { started(); await gate; ${create(table)} },
  async down({ db }) { ${drop(table)} },
});\n`,
    noop: () => `${esmImport}export default migration({ async up({ log }) { log?.push(import.meta.url.split("/").pop()); }, async down() {} });\n`,
    seed: (table, id, label) =>
      `${esmImport}export default seed(async ({ db }) => { await db.table(${JSON.stringify(table)}).insert({ id: ${id}, label: ${JSON.stringify(label)} }); });\n`,
    cjsSeed: (table, id, label) =>
      `exports.seed = async ({ db }) => { await db.table(${JSON.stringify(table)}).insert({ id: ${id}, label: ${JSON.stringify(label)} }); };\n`,
    defaultSeed: (table, id) =>
      `export default async function ({ db, label }) { await db.table(${JSON.stringify(table)}).insert({ id: ${id}, label }); }\n`,
    brokenSeed: (table, id) =>
      `${esmImport}export default seed(async ({ db }) => {
  await db.table(${JSON.stringify(table)}).insert({ id: ${id}, label: "rolled back" });
  throw new Error("seed broke");
});\n`,
  };
};

describe("migrations against a real database", () => {
  for (const engine of loadEngines()) {
    const skip = engine.skip || NOT_YET[engine.id] || false;
    describe(engine.label, { skip }, () => {
      const isSqlite = engine.id === "better-sqlite3";
      const dialect = DIALECT[engine.id];
      const transactionalDdl = !["mysql", "mariadb"].includes(dialect);
      const database = `tenora_mig_${randomBytes(3).toString("hex")}`;
      const config = isSqlite
        ? { client: "better-sqlite3", connection: { filename: path.join(scratch, `${database}.sqlite`) } }
        : serverConfig(engine, database);
      const connect = () => createConnection({ ...config, pool: { max: 5, acquireTimeoutMillis: 5_000 } });
      const files = sources(dialect);
      const dropAfter = new Set();
      let admin;
      let db;

      /** Tables the test creates, dropped after it along with the bookkeeping tables. */
      const tables = (...names) => names.forEach((name) => dropAfter.add(name));
      const exists = (table) => db.table(table).count().then(() => true, () => false);
      const recorded = (table = "tenora_migrations") => db.table(table).orderBy("id").pluck("name");

      before(async () => {
        if (!isSqlite) {
          admin = knex(engine.knexConfig(engine.adminDatabase));
          await engine.createDatabase(admin, database);
        }
        db = connect();
      });

      afterEach(async () => {
        for (const table of [...dropAfter, "tenora_migrations", "tenora_migrations_lock"]) {
          await db.raw(sql`drop table if exists ${sql.ref(table)}`);
        }
        dropAfter.clear();
      });

      after(async () => {
        await db?.destroy();
        if (admin) {
          await engine.cleanup(admin, { databases: [database], users: [] });
          await admin.destroy();
        }
      });

      it("runs pending migrations in batches, records them without their extension, and reports status", async () => {
        tables("alpha", "beta", "gamma", "delta");
        const dir = folder({
          "001_create_alpha.mjs": files.table("alpha"),
          "002_create_beta.cjs": files.cjsTable("beta"),
          "003_fill_alpha.js": files.fill("alpha", 1),
        });
        const migrator = createMigrator(db, { directory: dir });

        const initial = await migrator.status();
        assert.deepEqual(initial.ran, []);
        assert.deepEqual(initial.pending.map((p) => p.name), ["001_create_alpha", "002_create_beta", "003_fill_alpha"]);
        assert.equal(initial.pending[1].file, path.join(dir, "002_create_beta.cjs"));

        assert.deepEqual(await migrator.latest(), {
          batch: 1,
          migrations: ["001_create_alpha", "002_create_beta", "003_fill_alpha"],
        });
        assert.deepEqual(await recorded(), ["001_create_alpha", "002_create_beta", "003_fill_alpha"]);
        assert.deepEqual(await db.table("alpha").pluck("label"), ["filled"]);
        assert.equal(await exists("beta"), true);

        addFiles(dir, {
          "004_create_gamma.cjs": files.cjsMigration("gamma"),
          "005_create_delta.mjs": files.table("delta"),
        });
        const middle = await migrator.status();
        assert.deepEqual(middle.pending.map((p) => p.name), ["004_create_gamma", "005_create_delta"]);
        assert.deepEqual(await migrator.latest(), { batch: 2, migrations: ["004_create_gamma", "005_create_delta"] });
        assert.deepEqual(await migrator.latest(), { batch: 2, migrations: [] });

        const { ran, pending } = await migrator.status();
        assert.deepEqual(pending, []);
        assert.deepEqual(
          ran.map(({ name, batch, source }) => [name, batch, source]),
          [
            ["001_create_alpha", 1, "tenora"],
            ["002_create_beta", 1, "tenora"],
            ["003_fill_alpha", 1, "tenora"],
            ["004_create_gamma", 2, "tenora"],
            ["005_create_delta", 2, "tenora"],
          ]
        );
        assert.equal(ran[0].file, path.join(dir, "001_create_alpha.mjs"));
        for (const { migratedAt } of ran) {
          assert.ok(migratedAt instanceof Date && Math.abs(Date.now() - migratedAt.getTime()) < 10 * 60_000, String(migratedAt));
        }
      });

      it("rolls back the last batch, a number of steps, or everything, newest first", async () => {
        tables("t1", "t2", "t3", "t4");
        const log = [];
        const dir = folder({ "001_t1.mjs": files.logged("001", "t1"), "002_t2.mjs": files.logged("002", "t2") });
        const migrator = createMigrator(db, { directory: dir, context: () => ({ log }) });
        await migrator.latest();
        addFiles(dir, { "003_t3.mjs": files.logged("003", "t3"), "004_t4.mjs": files.logged("004", "t4") });
        await migrator.latest();

        assert.deepEqual(await migrator.rollback(), { batches: [2], migrations: ["004_t4", "003_t3"] });
        assert.deepEqual(await recorded(), ["001_t1", "002_t2"]);
        assert.equal(await exists("t3"), false);
        assert.equal(await exists("t2"), true);

        assert.deepEqual(await migrator.latest(), { batch: 2, migrations: ["003_t3", "004_t4"] });
        assert.deepEqual(await migrator.rollback({ step: 3 }), { batches: [2, 1], migrations: ["004_t4", "003_t3", "002_t2"] });
        assert.deepEqual(await recorded(), ["001_t1"]);

        assert.deepEqual(await migrator.latest(), { batch: 2, migrations: ["002_t2", "003_t3", "004_t4"] });
        assert.deepEqual(await migrator.rollback({ all: true }), {
          batches: [2, 1],
          migrations: ["004_t4", "003_t3", "002_t2", "001_t1"],
        });
        assert.deepEqual(await recorded(), []);
        for (const table of ["t1", "t2", "t3", "t4"]) assert.equal(await exists(table), false, table);
        assert.deepEqual(await migrator.rollback(), { batches: [], migrations: [] });

        assert.deepEqual(log, [
          "up 001", "up 002", "up 003", "up 004",
          "down 004", "down 003",
          "up 003", "up 004",
          "down 004", "down 003", "down 002",
          "up 002", "up 003", "up 004",
          "down 004", "down 003", "down 002", "down 001",
        ]);
        await assert.rejects(migrator.rollback({ step: 0 }), /whole number above 0/);
      });

      it(
        "runs outside a transaction open around the call",
        { skip: isSqlite && "SQLite has one connection, held by the transaction around the call" },
        async () => {
          tables("alpha");
          const migrator = createMigrator(db, { directory: folder({ "001_create_alpha.mjs": files.table("alpha") }) });
          await assert.rejects(
            db.transaction(async () => {
              await migrator.latest();
              throw new Error("the caller's transaction rolls back");
            }),
            /the caller's transaction rolls back/
          );
          assert.deepEqual(await recorded(), ["001_create_alpha"]);
          assert.equal(await exists("alpha"), true);
        }
      );

      it(
        transactionalDdl
          ? "rolls back a failing migration, records nothing, and stops the run with an error naming the file"
          : "records nothing for a failing migration and stops the run, though MySQL and MariaDB keep its DDL",
        async () => {
          tables("alpha", "half_done", "never_run");
          const dir = folder({
            "001_create_alpha.mjs": files.table("alpha"),
            "002_break.mjs": files.broken("half_done"),
            "003_never.mjs": files.table("never_run"),
          });
          const migrator = createMigrator(db, { directory: dir });

          const error = await migrator.latest().catch((e) => e);
          assert.ok(error instanceof MigrationError, String(error));
          assert.equal(error.migration, "002_break");
          assert.equal(error.file, path.join(dir, "002_break.mjs"));
          assert.equal(error.direction, "up");
          assert.equal(error.rolledBack, transactionalDdl);
          assert.match(error.message, /^Tenora: migration .*002_break\.mjs failed: broken on purpose/);
          assert.equal(error.cause.message, "broken on purpose");
          if (!transactionalDdl) assert.match(error.message, /commits schema changes as it runs them/);

          assert.deepEqual(await recorded(), ["001_create_alpha"]);
          assert.equal(await exists("half_done"), !transactionalDdl);
          assert.equal(await exists("never_run"), false);
          // The lock was released.
          assert.equal(await migrator.forceUnlock(), false);
        }
      );

      it("lets one migrator run at a time, and forceUnlock() releases a lock left behind", async () => {
        tables("waited");
        const started = deferred();
        const gate = deferred();
        const dir = folder({ "001_wait.mjs": files.waiting("waited") });
        const first = createMigrator(db, {
          directory: dir,
          context: () => ({ started: started.resolve, gate: gate.promise }),
        });
        // Another connection, as another process would have.
        const other = connect();
        try {
          const second = createMigrator(other, { directory: dir });
          const running = first.latest();
          await started.promise;

          const error = await second.latest().catch((e) => e);
          assert.ok(error instanceof MigrationLockError, String(error));
          assert.match(error.message, /^Tenora: .*locked.*forceUnlock\(\)/);
          await assert.rejects(second.rollback(), MigrationLockError);

          gate.resolve();
          assert.deepEqual(await running, { batch: 1, migrations: ["001_wait"] });
          assert.deepEqual(await second.latest(), { batch: 1, migrations: [] });

          // A run that was killed leaves the lock set.
          await db.table("tenora_migrations_lock").update({ is_locked: 1 });
          await assert.rejects(second.latest(), MigrationLockError);
          assert.equal(await second.forceUnlock(), true);
          assert.equal(await second.forceUnlock(), false);
          assert.deepEqual(await second.rollback(), { batches: [1], migrations: ["001_wait"] });
        } finally {
          await other.destroy();
        }
      });

      it("keeps its bookkeeping in a custom table", async () => {
        tables("alpha", "app_migrations", "app_migrations_lock");
        const dir = folder({ "001_create_alpha.mjs": files.table("alpha") });
        const migrator = createMigrator(db, { directory: dir, table: "app_migrations" });

        assert.deepEqual(await migrator.latest(), { batch: 1, migrations: ["001_create_alpha"] });
        assert.deepEqual(await recorded("app_migrations"), ["001_create_alpha"]);
        assert.deepEqual(await db.table("app_migrations_lock").get(), [{ id: 1, is_locked: 0 }]);
        assert.equal(await exists("tenora_migrations"), false);
        assert.equal(await exists("tenora_migrations_lock"), false);

        assert.deepEqual(await migrator.rollback(), { batches: [1], migrations: ["001_create_alpha"] });
        assert.deepEqual(await recorded("app_migrations"), []);
      });

      it("gives migrations the schema builder, or its Knex-compatible flavour for compat: \"knex\"", async () => {
        tables("laravel_style", "knex_style");
        const dir = folder({
          "001_laravel.mjs": `import { migration } from ${JSON.stringify(ORM_URL)};
export default migration({
  async up({ schema }) { await schema.create("laravel_style", (t) => { t.id(); t.string("label").unique(); }); },
  async down({ schema }) { await schema.drop("laravel_style"); },
});\n`,
          "002_knex.cjs": `const { migration } = require(${JSON.stringify(ORM_PATH)});
module.exports = migration({
  compat: "knex",
  up: ({ schema }) => schema.createTable("knex_style", (t) => { t.increments("id").primary(); t.string("label").notNullable(); }),
  down: ({ schema }) => schema.dropTableIfExists("knex_style"),
});\n`,
        });
        const migrator = createMigrator(db, { directory: dir });

        assert.deepEqual(await migrator.latest(), { batch: 1, migrations: ["001_laravel", "002_knex"] });
        await db.table("laravel_style").insert({ label: "a" });
        await db.table("knex_style").insert({ label: "b" });
        await assert.rejects(db.table("laravel_style").insert({ label: "a" }), /./);
        await migrator.rollback();
        assert.equal(await exists("laravel_style"), false);
        assert.equal(await exists("knex_style"), false);
      });

      describe("on SQLite, foreign keys are off while a migration runs", { skip: !isSqlite }, () => {
        const setUp = async () => {
          tables("children", "parents");
          await db.schema.create("parents", (t) => {
            t.id();
            t.string("name", 50);
          });
          await db.schema.create("children", (t) => {
            t.id();
            t.foreignId("parent_id").constrained("parents").cascadeOnDelete();
          });
          const id = await db.table("parents").insertGetId({ name: "a" });
          await db.table("children").insert({ parent_id: id });
          return id;
        };
        const enforced = async () => (await db.raw(sql`pragma foreign_keys`))[0].foreign_keys;

        it("rebuilds a referenced table in a migration without deleting through the cascade", async () => {
          await setUp();
          const dir = folder({
            "001_change.mjs": `export const up = ({ schema }) => schema.table("parents", (t) => t.text("name").change());\n`,
            "002_knex.mjs": `export const compat = "knex";
export const up = ({ schema }) => schema.alterTable("parents", (t) => t.text("name").nullable().alter());\n`,
          });
          assert.deepEqual((await createMigrator(db, { directory: dir }).latest()).migrations, ["001_change", "002_knex"]);
          assert.equal(await db.table("children").count(), 1, "the children survived");
          assert.equal(await enforced(), 1, "foreign keys are back on");
          await assert.rejects(db.table("children").insert({ parent_id: 999 }), /FOREIGN KEY/);
        });

        it("fails a migration that leaves rows pointing nowhere, and undoes it", async () => {
          await setUp();
          const dir = folder({
            "001_orphan.mjs": `export const up = ({ db }) => db.table("parents").delete();\n`,
          });
          const error = await createMigrator(db, { directory: dir }).latest().then(() => undefined, (e) => e);
          assert.ok(error instanceof MigrationError);
          assert.match(error.message, /left 1 row\(s\) pointing at rows that do not exist/);
          assert.equal(await db.table("parents").count(), 1, "the delete was rolled back");
          assert.deepEqual(await recorded(), []);
          assert.equal(await enforced(), 1);
        });

        it("does not blame a migration for rows that were already broken", async () => {
          const id = await setUp();
          await db.schema.withoutForeignKeyConstraints(() => db.table("parents").where("id", id).delete());
          const dir = folder({ "001_fine.mjs": `export const up = ({ db }) => db.table("parents").insert({ name: "b" });\n` });
          assert.deepEqual((await createMigrator(db, { directory: dir }).latest()).migrations, ["001_fine"]);
        });
      });

      it("runs .ts migration files, recorded without their extension", async () => {
        tables("typed");
        const dir = folder({ "001_typed.ts": files.typed("typed"), "001_typed.d.ts": "export {};\n" });
        const migrator = createMigrator(db, { directory: dir });

        assert.deepEqual(await migrator.latest(), { batch: 1, migrations: ["001_typed"] });
        assert.deepEqual(await recorded(), ["001_typed"]);
        assert.deepEqual(await db.table("typed").pluck("label"), ["typed"]);
        assert.equal((await migrator.status()).ran[0].file, path.join(dir, "001_typed.ts"));
        assert.deepEqual(await migrator.rollback(), { batches: [1], migrations: ["001_typed"] });
        assert.equal(await exists("typed"), false);
      });

      it(
        "honours transaction: false, written the Knex way",
        { skip: dialect !== "postgres" && "only Postgres refuses a statement inside a transaction here" },
        async () => {
          tables("indexed");
          await db.raw(sql`${sql.raw(CREATE.postgres("indexed"))}`);
          const index = (name) =>
            "await db.raw(sql`create index concurrently " + name + " on indexed (label)`);";
          const cjsRequire = `const { sql } = require(${JSON.stringify(ORM_PATH)});\n`;
          const inside = folder({ "001_index.cjs": `${cjsRequire}exports.up = async ({ db }) => { ${index("inside_idx")} };\n` });
          const outside = folder({
            "001_index.cjs": `${cjsRequire}exports.up = async ({ db }) => { ${index("outside_idx")} };\nexports.config = { transaction: false };\n`,
          });
          await assert.rejects(createMigrator(db, { directory: inside }).latest(), /cannot run inside a transaction block/);
          assert.deepEqual(await createMigrator(db, { directory: outside }).latest(), { batch: 1, migrations: ["001_index"] });
        }
      );

      it("runs seeds in name order, each in a transaction of its own", async () => {
        tables("seeded");
        await db.raw(sql`${sql.raw(CREATE[dialect]("seeded"))}`);
        const dir = folder({
          "01_first.mjs": files.seed("seeded", 1, "first"),
          "02_second.cjs": files.cjsSeed("seeded", 2, "second"),
          "03_third.js": files.defaultSeed("seeded", 3),
        });
        const seeder = createSeeder(db, { directory: dir, context: () => ({ label: "third" }) });
        const labels = () => db.table("seeded").orderBy("id").pluck("label");

        assert.deepEqual(await seeder.run(), { seeds: ["01_first", "02_second", "03_third"] });
        assert.deepEqual(await labels(), ["first", "second", "third"]);

        await db.table("seeded").delete();
        assert.deepEqual(await seeder.run({ only: "02_second.cjs" }), { seeds: ["02_second"] });
        assert.deepEqual(await seeder.run({ only: ["03_third", "01_first"] }), { seeds: ["01_first", "03_third"] });
        assert.deepEqual(await labels(), ["first", "second", "third"]);
        await assert.rejects(seeder.run({ only: "04_missing" }), /^Error: Tenora: no seed named 04_missing/);

        await db.table("seeded").delete();
        const broken = folder({
          "01_ok.mjs": files.seed("seeded", 10, "kept"),
          "02_broken.mjs": files.brokenSeed("seeded", 11),
          "03_after.mjs": files.seed("seeded", 12, "never"),
        });
        const error = await createSeeder(db, { directory: broken }).run().catch((e) => e);
        assert.ok(error instanceof SeedError, String(error));
        assert.equal(error.seed, "02_broken");
        assert.match(error.message, /^Tenora: the seed .*02_broken\.mjs failed: seed broke/);
        assert.deepEqual(await labels(), ["kept"]);
      });
    });
  }
});

describe("migration files", () => {
  let db;
  const dropAfter = new Set(["tenora_migrations", "tenora_migrations_lock"]);

  before(() => {
    db = createConnection({ client: "better-sqlite3", connection: { filename: path.join(scratch, "files.sqlite") } });
  });
  afterEach(async () => {
    for (const table of dropAfter) await db.raw(sql`drop table if exists ${sql.ref(table)}`);
  });
  after(() => db?.destroy());

  const files = sources("sqlite");

  it("sorts names across directories by code unit, as Knex does, and skips files that are not migrations", async () => {
    const first = folder({
      "002_b.mjs": files.noop(),
      "20240101_a.mjs": files.noop(),
      "README.md": "# not a migration\n",
      "helpers.d.ts": "export {};\n",
      ".#002_b.mjs": "this is an editor lock file",
    });
    const second = folder({ "001_a.mjs": files.noop(), "20240101_B.mjs": files.noop() });
    const log = [];
    const migrator = createMigrator(db, { directories: [first, second], context: () => ({ log }) });

    // Uppercase sorts before lowercase in code units, unlike localeCompare.
    const order = ["001_a", "002_b", "20240101_B", "20240101_a"];
    assert.deepEqual((await migrator.status()).pending.map((p) => p.name), order);
    assert.deepEqual((await migrator.latest()).migrations, order);
    assert.deepEqual(log, order.map((name) => `${name}.mjs`));
  });

  it("refuses two files with the same name, which would share a record", async () => {
    const dir = folder({ "001_a.mjs": files.noop(), "001_a.ts": files.noop() });
    await assert.rejects(createMigrator(db, { directory: dir }).latest(), /both migration "001_a"/);
  });

  it("loads every pending file before running any", async () => {
    dropAfter.add("alpha");
    const dir = folder({ "001_create_alpha.mjs": files.table("alpha"), "002_nothing.mjs": "export const nothing = 1;\n" });
    const migrator = createMigrator(db, { directory: dir });
    await assert.rejects(migrator.latest(), /^Error: Tenora: .*002_nothing\.mjs does not export a migration/);
    assert.deepEqual((await migrator.status()).ran, []);
    await assert.rejects(db.table("alpha").count());
  });

  it("refuses to roll back a migration without down, or without its file, before rolling back anything", async () => {
    dropAfter.add("alpha").add("beta");
    const dir = folder({
      "001_create_alpha.mjs": files.table("alpha"),
      "002_create_beta.mjs": files.table("beta"),
      "003_one_way.mjs": `import { migration } from ${JSON.stringify(ORM_URL)};\nexport default migration({ up() {} });\n`,
    });
    const migrator = createMigrator(db, { directory: dir });
    await migrator.latest();
    await assert.rejects(migrator.rollback(), /cannot roll back .*003_one_way\.mjs: no down function/);
    assert.deepEqual((await migrator.status()).ran.map((m) => m.name), ["001_create_alpha", "002_create_beta", "003_one_way"]);

    // A file pruned into a schema dump: latest() carries on, rollback() cannot undo it.
    fs.rmSync(path.join(dir, "003_one_way.mjs"));
    fs.rmSync(path.join(dir, "002_create_beta.mjs"));
    assert.deepEqual((await migrator.latest()).migrations, []);
    assert.equal((await migrator.status()).ran[1].file, undefined);
    await assert.rejects(migrator.rollback({ all: true }), /cannot roll back 003_one_way, 002_create_beta: no file/);
    assert.equal((await migrator.status()).ran.length, 3);
    await db.table("alpha").count();
  });

  it("refuses to carry on when a database never ran a migration that was pruned into a dump", async () => {
    const dir = folder({ "002_create_gamma.mjs": `export const up = () => {};\n` });
    const pruned = { migrations: ["001_pruned"], into: "schema/tenant.sql" };
    const lagging = createMigrator(db, { directory: dir, pruned, table: "lagging_migrations" });
    await assert.rejects(lagging.latest(), /never ran migration "001_pruned".*pruned into the schema dump schema\/tenant\.sql/);
    assert.deepEqual((await lagging.status()).ran, []);

    await db.table("lagging_migrations").insert({ name: "001_pruned", batch: 1, migrated_at: new Date(), source: "tenora" });
    assert.deepEqual((await lagging.latest()).migrations, ["002_create_gamma"]);
    assert.deepEqual((await listMigrationFiles({ directory: dir })).map((file) => file.name), ["002_create_gamma"]);
  });

  it("checks its options", () => {
    assert.throws(() => createMigrator(db, {}), /needs a directory/);
    assert.throws(() => createMigrator(db, { directory: "a", directories: ["b"] }), /not both/);
    assert.throws(() => createSeeder(db, {}), /needs a directory/);
  });

  it("reports a directory that does not exist", async () => {
    await assert.rejects(
      createMigrator(db, { directory: path.join(scratch, "missing") }).latest(),
      /the migration directory .*missing does not exist/
    );
  });
});
