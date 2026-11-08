import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import knex from "knex";
import { createTenoraFactory } from "../packages/multi-tenant/dist/index.js";
import { loadEngines } from "./support/engines.mjs";
import { assertFailed, assertOk, createProject, MULTI_TENANT_BIN } from "./support/project.mjs";
import { runInTerminal, terminalMissing } from "./support/terminal.mjs";

const TENANT_PASSWORD = "Tenant_tree_pw1";
const ESCAPE = "\x1b";

const creating = (table) =>
  `export const up = (knex) => knex.schema.createTable("${table}", (t) => { t.increments("id"); });\nexport const down = (knex) => knex.schema.dropTableIfExists("${table}");\n`;

const BROKEN = `export const up = async () => { throw new Error("boom in migration"); };\nexport const down = async () => {};\n`;

const brokenFor = (marker, table) =>
  `export const up = async (knex) => {\n  const { database, filename } = knex.client.config.connection;\n  if (String(database ?? filename).includes("${marker}")) throw new Error("boom for this tenant");\n  await knex.schema.createTable("${table}", (t) => { t.increments("id"); });\n};\nexport const down = (knex) => knex.schema.dropTableIfExists("${table}");\n`;

const assertTerminalOk = (result) => {
  assert.equal(result.status, 0, `expected exit code 0, got ${result.status}:\n${result.screen}`);
  return result;
};

const assertTerminalFailed = (result) => {
  assert.equal(result.status, 1, `expected exit code 1, got ${result.status}:\n${result.screen}`);
  return result;
};

const appliedRows = async (db) =>
  db("knex_migrations").select("name", "batch").orderBy("id");

describe("task tree on a real database", { skip: terminalMissing }, () => {
  for (const engine of loadEngines()) {
    describe(engine.label, { skip: engine.skip }, () => {
      const run = randomBytes(3).toString("hex");
      const baseDb = `tt_${run}_base`;
      const tenants = { ok: `tt_${run}_a`, bad: `tt_${run}_b_bad`, later: `tt_${run}_c` };
      const userOf = (tenantId) => `user_${tenantId}`;
      const project = createProject();
      const connections = new Map();
      let admin;

      const terminal = (args, options) => runInTerminal(project, args, options);

      const configWith = (root) => {
        const { base, tenant } = engine.config(project, baseDb);
        return {
          base: { ...base, migrationsDir: `${root}migrations/base`, seedsDir: `${root}seeds/base` },
          tenant: { ...tenant, migrationsDir: `${root}migrations/tenants`, seedsDir: `${root}seeds/tenants` },
        };
      };

      /** An independent connection used only to observe what Tenora did. */
      const observe = (database) => {
        const location = engine.locate(project, database);
        if (!connections.has(location)) connections.set(location, knex(engine.knexConfig(location)));
        return connections.get(location);
      };

      const baseMigrations = async () =>
        (await appliedRows(observe(baseDb))).filter((row) => !row.name.includes("registry"));

      const writeBase = (name, content) => project.write(`migrations/base/${name}`, content);

      before(() => {
        project.write("migrations/tenants/20000101000000_create_notes.js", creating("notes"));
        project.write("seeds/base/plans.js", `export const seed = async (knex) => { await knex.schema.createTable("seeded_plans", (t) => { t.string("name"); }); };\n`);
        project.write("seeds/tenants/notes.js", `export const seed = async (knex) => { await knex("notes").insert({}); };\n`);
        project.writeConfig(configWith(""));
        if (engine.server) admin = knex(engine.knexConfig(undefined));
        assertOk(project.tenora(["migrate", "--create-base"]));
        assertOk(project.tenora(["migrate"]));
      });

      after(async () => {
        for (const connection of connections.values()) await connection.destroy();
        if (admin) {
          const all = Object.values(tenants);
          await engine.cleanup(admin, { databases: [baseDb, ...all], users: all.map(userOf) });
          await admin.destroy();
        }
        project.remove();
      });

      it("shows every migration, keeps them in one batch, and rollback undoes them together", async () => {
        writeBase("20270101000000_create_a.js", creating("tree_a"));
        writeBase("20270101000001_create_b.js", creating("tree_b"));

        const { screen } = assertTerminalOk(terminal(["migrate"]));
        assert.match(screen, /✔ 20270101000000_create_a\.js/);
        assert.match(screen, /✔ 20270101000001_create_b\.js/);
        assert.match(screen, /✔ Base migrated: 2 migrations/);

        const rows = await baseMigrations();
        assert.equal(rows.length, 2);
        assert.equal(rows[0].batch, rows[1].batch);

        const undone = assertTerminalOk(terminal(["rollback"])).screen;
        assert.match(undone, /✔ Base rolled back: 2 migrations/);
        assert.deepEqual(await baseMigrations(), []);
      });

      it("reports each step of a failed batch the way the database ended up", async () => {
        writeBase("20270101000002_broken.js", BROKEN);

        const { screen } = assertTerminalFailed(terminal(["migrate"]));
        assert.match(screen, /✖ 20270101000002_broken\.js\n\s+boom in migration/);
        assert.doesNotMatch(screen, /migration failed with error/, "knex's own failure log is shown too");

        const kept = new Set((await baseMigrations()).map((row) => row.name));
        for (const name of ["20270101000000_create_a.js", "20270101000001_create_b.js"]) {
          // SQL Server, Postgres and SQLite undo the batch, while MySQL commits at each table change.
          const mark = kept.has(name) ? "✔" : "↩";
          assert.ok(screen.includes(`${mark} ${name}`), `expected ${mark} ${name} in:\n${screen}`);
        }

        project.delete("migrations/base/20270101000002_broken.js");
        assertOk(project.tenora(["migrate"]));
        assertOk(project.tenora(["rollback"]));
        while ((await baseMigrations()).length) assertOk(project.tenora(["rollback"]));
      });

      it("--step gives every migration its own batch, so rollback undoes one at a time", async () => {
        const { screen } = assertTerminalOk(terminal(["migrate", "--step"]));
        assert.match(screen, /✔ Base migrated: 2 migrations/);
        const rows = await baseMigrations();
        assert.deepEqual(rows.map((row) => row.name), ["20270101000000_create_a.js", "20270101000001_create_b.js"]);
        assert.equal(rows[1].batch, rows[0].batch + 1);

        assert.match(assertTerminalOk(terminal(["rollback"])).screen, /✔ Base rolled back: 1 migration in/);
        assert.deepEqual((await baseMigrations()).map((row) => row.name), ["20270101000000_create_a.js"]);
        assertOk(project.tenora(["rollback"]));
        assert.deepEqual(await baseMigrations(), []);
      });

      it("--step without a terminal does the same and prints what it always printed", async () => {
        const output = assertOk(project.tenora(["migrate", "--step"])).stdout;
        assert.equal(output, "20270101000000_create_a.js\n20270101000001_create_b.js\n");
        const rows = await baseMigrations();
        assert.equal(rows[1].batch, rows[0].batch + 1);
        assert.equal(assertOk(project.tenora(["rollback"])).stdout, "20270101000001_create_b.js\n");
        assert.equal(assertOk(project.tenora(["rollback"])).stdout, "20270101000000_create_a.js\n");
      });

      it("--step keeps what finished before a failure", async () => {
        writeBase("20270101000002_broken.js", BROKEN);
        writeBase("20270101000003_create_c.js", creating("tree_c"));

        const { screen } = assertTerminalFailed(terminal(["migrate", "--step"]));
        assert.match(screen, /✔ 20270101000000_create_a\.js/);
        assert.match(screen, /✔ 20270101000001_create_b\.js/);
        assert.match(screen, /✖ 20270101000002_broken\.js/);
        assert.match(screen, /○ 20270101000003_create_c\.js {2}not run/);
        assert.equal((await baseMigrations()).length, 2);

        project.delete("migrations/base/20270101000002_broken.js");
        project.delete("migrations/base/20270101000003_create_c.js");
        assertOk(project.tenora(["rollback"]));
        assertOk(project.tenora(["rollback"]));
      });

      it("seeds the base database", () => {
        const { screen } = assertTerminalOk(terminal(["seed:run"]));
        assert.match(screen, /✔ plans\.js/);
        assert.match(screen, /✔ Base seeded: 1 seed in/);
      });

      describe("tenants", () => {
        const createTenant = async (tenantId) => {
          const manager = createTenoraFactory(configWith(`${project.dir}/`));
          try {
            await manager.createTenantDb(tenantId, engine.perTenantUsers ? TENANT_PASSWORD : undefined);
          } finally {
            await manager.destroyAll();
          }
        };

        before(async () => {
          // In this order, so the failing tenant has one before and one after it.
          await createTenant(tenants.ok);
          await createTenant(tenants.bad);
          await createTenant(tenants.later);
          project.write("migrations/tenants/20270101000010_create_labels.js", creating("labels"));
        });

        it("migrate:tenants shows a line per tenant and the total", async () => {
          const { screen } = assertTerminalOk(terminal(["migrate:tenants"]));
          for (const tenant of Object.values(tenants)) {
            assert.ok(screen.includes(`✔ ${tenant}  1 migration`), `${tenant} missing in:\n${screen}`);
            assert.equal((await appliedRows(observe(tenant))).length, 2);
          }
          assert.match(screen, /✔ 3 tenants migrated in/);
        });

        it("says when every tenant is up to date", () => {
          const { screen } = assertTerminalOk(terminal(["migrate:tenants"]));
          assert.ok(screen.includes(`– ${tenants.ok}  up to date`), screen);
          assert.match(screen, /✔ 3 tenants up to date in/);
        });

        it("stops at the failing tenant and says what was left", async () => {
          project.write("migrations/tenants/20270101000011_create_tags.js", brokenFor("_bad", "tags"));

          const { screen } = assertTerminalFailed(terminal(["migrate:tenants"]));
          assert.ok(screen.includes(`✔ ${tenants.ok}  1 migration`), screen);
          assert.ok(screen.includes(`✖ ${tenants.bad}`), screen);
          assert.match(screen, /boom for this tenant/);
          assert.ok(screen.includes(`✖ Stopped on ${tenants.bad}. 1 tenant migrated, 1 not started.`), screen);
          assert.ok(!screen.includes(tenants.later), `${tenants.later} should not have started:\n${screen}`);
          assert.equal((await appliedRows(observe(tenants.later))).length, 2);
        });

        it("seed:run:tenants and rollback:tenants report every tenant", async () => {
          assertOk(project.tenora(["rollback:tenants"]));
          project.delete("migrations/tenants/20270101000011_create_tags.js");

          const seeded = assertTerminalOk(terminal(["seed:run:tenants"])).screen;
          assert.ok(seeded.includes(`✔ ${tenants.ok}  1 seed`), seeded);
          assert.match(seeded, /✔ 3 tenants seeded in/);
          assert.equal((await observe(tenants.later)("notes").select()).length, 2);

          const rollback = assertTerminalOk(terminal(["rollback:tenants"])).screen;
          assert.ok(rollback.includes(`✔ ${tenants.later}  1 migration`), rollback);
          assert.match(rollback, /✔ 3 tenants rolled back in/);
        });
      });
    });
  }
});

describe("task tree details", { skip: terminalMissing }, () => {
  const projects = [];

  const sqliteProject = ({ tenants = true } = {}) => {
    const project = createProject();
    projects.push(project);
    project.writeConfig({
      base: { client: "sqlite3", database: "data/base.sqlite", migrationsDir: "migrations/base", seedsDir: "seeds/base" },
      tenant: tenants ? { migrationsDir: "migrations/tenants", databaseDir: "data" } : undefined,
    });
    assertOk(project.tenora(["migrate", "--create-base"]));
    assertOk(project.tenora(["migrate"]));
    return project;
  };

  const observed = async (project, work) => {
    const db = knex({ client: "sqlite3", useNullAsDefault: true, connection: { filename: project.path("data/base.sqlite") } });
    try {
      return await work(db);
    } finally {
      await db.destroy();
    }
  };

  after(() => {
    for (const project of projects) project.remove();
  });

  it("leaves a clean final screen after a run", () => {
    const project = sqliteProject();
    project.write("migrations/base/20270101000000_create_a.js", creating("a"));
    project.write("migrations/base/20270101000001_create_b.js", creating("b"));

    assert.equal(
      assertTerminalOk(runInTerminal(project, ["migrate"])).screen,
      [
        "",
        "tenora migrate",
        "",
        "  ✔ 20270101000000_create_a.js  <t>",
        "  ✔ 20270101000001_create_b.js  <t>",
        "",
        "✔ Base migrated: 2 migrations in <t>.",
        "",
      ].join("\n")
    );
    assert.equal(
      assertTerminalOk(runInTerminal(project, ["migrate"])).screen,
      ["", "tenora migrate", "", "✔ Base is up to date.", ""].join("\n")
    );
  });

  it("shows the whole failed batch, with what was undone and what never ran", () => {
    const project = sqliteProject();
    project.write("migrations/base/20270101000000_create_a.js", creating("a"));
    project.write("migrations/base/20270101000001_broken.js", BROKEN);
    project.write("migrations/base/20270101000002_create_c.js", creating("c"));

    assert.equal(
      assertTerminalFailed(runInTerminal(project, ["migrate"])).screen,
      [
        "",
        "tenora migrate",
        "",
        "✖ Base",
        "  ↩ 20270101000000_create_a.js  rolled back",
        "  ✖ 20270101000001_broken.js",
        "    boom in migration",
        "  ○ 20270101000002_create_c.js  not run",
        "",
      ].join("\n")
    );
  });

  it("keeps a migration's own transaction setting, in ESM and CommonJS", async () => {
    const project = sqliteProject();
    project.write("migrations/base/20270101000000_create_a.js", `${creating("a")}export const config = { transaction: false };\n`);
    project.write("migrations/base/20270101000001_broken.cjs", `exports.up = async () => { throw new Error("boom"); };\nexports.down = async () => {};\nexports.config = { transaction: false };\n`);

    const { screen } = assertTerminalFailed(runInTerminal(project, ["migrate"]));
    assert.match(screen, /✔ 20270101000000_create_a\.js/, "it ran outside the batch's transaction, so it stays");
    const names = await observed(project, async (db) => (await appliedRows(db)).map((row) => row.name));
    assert.ok(names.includes("20270101000000_create_a.js"));
  });

  it("prints what a migration logs above the tree, and knex's other warnings too", () => {
    const project = sqliteProject();
    project.write(
      "migrations/base/20270101000000_logging.js",
      `export const up = async () => { console.log("hello from a migration"); };\nexport const down = async () => {};\n`
    );
    project.write(
      "migrations/base/20270101000001_no_promise.js",
      `export const up = () => {};\nexport const down = () => {};\n`
    );

    const { screen } = assertTerminalOk(runInTerminal(project, ["migrate"]));
    assert.match(screen, /hello from a migration\n/);
    assert.match(screen, /did not return a promise/);
    assert.match(screen, /✔ Base migrated: 2 migrations/);
  });

  const manyMigrations = (project) => {
    const names = Array.from({ length: 60 }, (_, i) => `2027010100${String(i).padStart(4, "0")}_create_t.js`);
    for (const [i, name] of names.entries()) {
      project.write(`migrations/base/${name}`, `export const up = async (knex) => { await knex.schema.createTable("t${i}", (t) => { t.increments("id"); }); await new Promise((r) => setTimeout(r, 15)); };\nexport const down = async () => {};\n`);
    }
    return names;
  };

  const frameHeights = (raw) => [...raw.matchAll(/\x1b\[(\d+)A\x1b\[0J/g)].map((match) => Number(match[1]));

  it("shows the part of a long list around the running migration, and all of it at the end", () => {
    const project = sqliteProject();
    const names = manyMigrations(project);

    const { raw, screen } = assertTerminalOk(runInTerminal(project, ["migrate"], { rows: 20 }));
    const heights = frameHeights(raw);
    assert.ok(heights.length > 0, "the frame was never redrawn");
    assert.ok(Math.max(...heights) < 20, `a frame was ${Math.max(...heights)} lines tall`);
    assert.match(raw, /… \d+ finished/);
    assert.match(raw, /… \d+ more/);
    for (const name of names) assert.ok(screen.includes(`✔ ${name}`), `${name} missing`);
  });

  it("stays inside even a tiny terminal", () => {
    const project = sqliteProject();
    manyMigrations(project);

    const { raw, screen } = assertTerminalOk(runInTerminal(project, ["migrate"], { rows: 5 }));
    assert.ok(Math.max(...frameHeights(raw)) < 5, `a frame was ${Math.max(...frameHeights(raw))} lines tall`);
    assert.match(screen, /✔ Base migrated: 60 migrations/);
  });

  it("stays inside a tiny terminal with the progress bar showing too", async () => {
    const project = sqliteProject();
    const manager = createTenoraFactory({
      base: { client: "sqlite3", database: project.path("data/base.sqlite"), migrationsDir: project.path("migrations/base") },
      tenant: { databaseDir: project.path("data") },
    });
    await manager.createTenantDb("acme");
    await manager.destroyAll();
    for (let i = 0; i < 12; i += 1) {
      project.write(`migrations/tenants/2027010100${String(i).padStart(4, "0")}_create_t.js`, `export const up = async (knex) => { await knex.schema.createTable("t${i}", (t) => { t.increments("id"); }); await new Promise((r) => setTimeout(r, 15)); };\nexport const down = async () => {};\n`);
    }

    const { raw, screen } = assertTerminalOk(runInTerminal(project, ["migrate:tenants"], { rows: 5 }));
    assert.ok(Math.max(...frameHeights(raw)) < 5, `a frame was ${Math.max(...frameHeights(raw))} lines tall`);
    assert.match(screen, /✔ acme {2}12 migrations/);
  });

  it("honours a custom migrations table", async () => {
    const project = createProject();
    projects.push(project);
    project.writeConfig({
      base: { client: "sqlite3", database: "data/base.sqlite", migrationsDir: "migrations/base" },
      knexOptions: { migrations: { directory: "migrations/base", tableName: "custom_migrations" } },
    });
    assertOk(project.tenora(["migrate", "--create-base"]));
    assertOk(project.tenora(["migrate"]));
    project.write("migrations/base/20270101000000_create_a.js", creating("a"));

    assertTerminalOk(runInTerminal(project, ["migrate"]));
    const rows = await observed(project, (db) => db("custom_migrations").select("name"));
    assert.ok(rows.some((row) => row.name === "20270101000000_create_a.js"), JSON.stringify(rows));
    assert.match(assertTerminalOk(runInTerminal(project, ["rollback"])).screen, /✔ Base rolled back: 1 migration in/);
  });

  it("turns line wrapping off only while drawing the frame", () => {
    const project = sqliteProject();
    project.write("migrations/base/20270101000000_create_a.js", creating("a"));

    const { raw } = assertTerminalOk(runInTerminal(project, ["migrate"], { columns: 20 }));
    assert.ok(raw.includes("\x1b[?7l"));
    assert.equal(raw.split("\x1b[?7l").length, raw.split("\x1b[?7h").length);
  });

  it("restores the cursor when interrupted", () => {
    const project = sqliteProject();
    project.write(
      "migrations/base/20270101000000_interrupted.js",
      `export const up = async () => { await new Promise((r) => setTimeout(r, 200)); process.kill(process.pid, "SIGINT"); await new Promise((r) => setTimeout(r, 30000)); };\nexport const down = async () => {};\n`
    );

    const { raw, status } = runInTerminal(project, ["migrate"]);
    assert.equal(status, 130);
    assert.ok(raw.includes("\x1b[?25l"), "the cursor was never hidden");
    assert.ok(raw.lastIndexOf("\x1b[?25h") > raw.lastIndexOf("\x1b[?25l"), "the cursor is still hidden");
  });

  it("restores the cursor after a normal run", () => {
    const project = sqliteProject();
    project.write("migrations/base/20270101000000_create_a.js", creating("a"));
    const { raw } = assertTerminalOk(runInTerminal(project, ["migrate"]));
    assert.ok(raw.lastIndexOf("\x1b[?25h") > raw.lastIndexOf("\x1b[?25l"));
  });

  it("works through a pruned schema dump", async () => {
    const project = sqliteProject();
    project.write("migrations/tenants/20270101000000_create_notes.js", creating("notes"));
    const manager = createTenoraFactory({
      base: { client: "sqlite3", database: project.path("data/base.sqlite"), migrationsDir: project.path("migrations/base") },
      tenant: { migrationsDir: project.path("migrations/tenants"), databaseDir: project.path("data") },
    });
    await manager.createTenantDb("acme");
    await manager.destroyAll();

    const dumped = assertTerminalOk(runInTerminal(project, ["schema:dump:tenants", "--prune"])).screen;
    assert.match(dumped, /✔ Schema dump .*: 1 migrations/);
    assert.match(dumped, /✔ Pruned .*20270101000000_create_notes\.js/);

    project.write("migrations/tenants/20270101000001_create_tags.js", creating("tags"));
    const { screen } = assertTerminalOk(runInTerminal(project, ["migrate:tenants"]));
    assert.match(screen, /✔ acme {2}1 migration/);
    assert.match(assertTerminalOk(runInTerminal(project, ["rollback:tenants"])).screen, /✔ acme {2}1 migration/);
  });

  it("gives the other commands a short result line", () => {
    const project = sqliteProject();
    const made = assertTerminalOk(runInTerminal(project, ["make:migration:tenants", "add_thing"])).screen;
    assert.match(made, /^✔ .*_add_thing\.js$/);

    const refused = assertTerminalFailed(runInTerminal(project, ["drop:tenant", "acme"])).screen;
    assert.match(refused, /^✖ Tenora: this permanently deletes tenant "acme"\. Re-run with --force to confirm\.$/);

    const missing = assertTerminalFailed(runInTerminal(project, ["schema:dump:tenants", "--check"])).screen;
    assert.match(missing, /^✖ Tenora: there is no schema dump at /);
  });

  it("drops a tenant with a result line", async () => {
    const project = sqliteProject();
    const manager = createTenoraFactory({
      base: { client: "sqlite3", database: project.path("data/base.sqlite"), migrationsDir: project.path("migrations/base") },
      tenant: { databaseDir: project.path("data") },
    });
    await manager.createTenantDb("acme");
    await manager.destroyAll();

    const { screen } = assertTerminalOk(runInTerminal(project, ["drop:tenant", "acme", "--force"]));
    assert.equal(screen, "✔ Tenant acme: dropped");
  });

  it("shows a config problem as one line instead of a stack trace", () => {
    const project = createProject();
    projects.push(project);
    const { screen } = assertTerminalFailed(runInTerminal(project, ["migrate"]));
    assert.match(screen, /^✖ Tenora: no config found/);
    assert.doesNotMatch(screen, /\n\s+at /);
  });

  it("explains that there are no tenants", () => {
    const project = sqliteProject();
    assert.match(assertTerminalOk(runInTerminal(project, ["migrate:tenants"])).screen, /– No tenants\./);
  });

  it("the tenora command of @tenora/multi-tenant shows the tree too", () => {
    const project = sqliteProject();
    project.write("migrations/base/20270101000000_create_a.js", creating("a"));
    const { screen } = assertTerminalOk(runInTerminal(project, ["migrate"], { bin: MULTI_TENANT_BIN }));
    assert.match(screen, /✔ Base migrated: 1 migration in/);
  });

  it("uses no colours with NO_COLOR", () => {
    const project = sqliteProject();
    project.write("migrations/base/20270101000000_create_a.js", creating("a"));
    const { raw } = assertTerminalOk(runInTerminal(project, ["migrate"], { env: { NO_COLOR: "1" } }));
    assert.doesNotMatch(raw, /\x1b\[[\d;]*m/);
    assert.match(raw, /✔ 20270101000000_create_a\.js/);
  });

  for (const [name, options] of [
    ["CI is set", { env: { CI: "true" } }],
    ["the terminal is dumb", { env: { TERM: "dumb" } }],
    ["stderr goes to a file", { redirect: "2>/dev/null" }],
  ]) {
    it(`prints plain lines when ${name}`, () => {
      const project = sqliteProject();
      project.write("migrations/base/20270101000000_create_a.js", creating("a"));
      const { plain, status } = runInTerminal(project, ["migrate"], options);
      assert.equal(status, 0);
      assert.equal(plain, "20270101000000_create_a.js\n");
    });
  }

  it("prints exactly the old lines, with no escape codes, when output is piped", () => {
    const project = sqliteProject();
    project.write("migrations/base/20270101000000_create_a.js", creating("a"));
    project.write("seeds/base/plans.js", `export const seed = async () => {};\n`);

    assert.equal(assertOk(project.tenora(["migrate"])).stdout, "20270101000000_create_a.js\n");
    assert.equal(assertOk(project.tenora(["migrate"])).stdout, "Base up to date\n");
    assert.equal(assertOk(project.tenora(["seed:run"])).stdout, `${project.path("seeds/base/plans.js")}\n`);
    assert.equal(assertOk(project.tenora(["rollback"])).stdout, "20270101000000_create_a.js\n");
    assert.ok(!assertOk(project.tenora(["migrate:tenants"])).output.includes(ESCAPE));

    project.write("migrations/base/20270101000001_broken.js", BROKEN);
    const failed = assertFailed(project.tenora(["migrate"]));
    assert.match(failed.stdout, /migration file "20270101000001_broken\.js" failed/);
    assert.match(failed.stderr, /boom in migration/);
    assert.match(failed.stderr, /\n\s+at /, "a failure without a terminal keeps its stack trace");
  });
});
