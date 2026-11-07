import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import knex from "knex";
import { createTenoraFactory } from "../packages/multi-tenant/dist/index.js";
import { loadEngines } from "./support/engines.mjs";
import { assertFailed, assertOk, createProject } from "./support/project.mjs";

const REGISTRY = "tenora_tenants";
const TENANT_PASSWORD = "Tenant_dump_pw1";

const DIALECTS = {
  sqlite3: "sqlite",
  "better-sqlite3": "sqlite",
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
};

// The same lookup Tenora does, so a missing tool is reported here instead of as a failed dump.
const DUMP_TOOLS = {
  postgres: () => [process.env.TENORA_PG_DUMP || "pg_dump"],
  mysql: () => (process.env.TENORA_MYSQLDUMP ? [process.env.TENORA_MYSQLDUMP] : ["mysqldump", "mariadb-dump"]),
  mariadb: () => {
    const configured = process.env.TENORA_MARIADB_DUMP || process.env.TENORA_MYSQLDUMP;
    return configured ? [configured] : ["mariadb-dump", "mysqldump"];
  },
};

const missingDumpTool = (dialect) => {
  const candidates = DUMP_TOOLS[dialect]?.();
  if (!candidates) return undefined;
  const found = candidates.some((tool) => !spawnSync(tool, ["--version"]).error);
  return found ? undefined : `no ${candidates.join(" or ")} on this machine`;
};

const migrationFile = (up, down) => `export const up = ${up};\nexport const down = ${down};\n`;

const raw = (...statements) =>
  `async (knex) => {\n${statements.map((sql) => `  await knex.raw(${JSON.stringify(sql)});`).join("\n")}\n}`;

// Function bodies and trigger blocks contain semicolons, which is what the dump loaders must survive.
const TRIGGERS = {
  postgres: {
    up: raw(
      "create function upper_note_name() returns trigger as $$ begin new.name := upper(new.name); return new; end; $$ language plpgsql",
      "create trigger notes_upper before insert on notes for each row execute function upper_note_name()"
    ),
    down: raw("drop trigger notes_upper on notes", "drop function upper_note_name()"),
  },
  mysql: {
    up: raw("create trigger notes_upper before insert on notes for each row begin set new.name = upper(new.name); end"),
    down: raw("drop trigger notes_upper"),
  },
  sqlite: {
    up: raw("create trigger notes_upper after insert on notes begin update notes set name = upper(name) where id = new.id; end"),
    down: raw("drop trigger notes_upper"),
  },
};

const MIGRATIONS = {
  "20000101000000_create_notes.js": migrationFile(
    `(knex) => knex.schema.createTable("notes", (t) => { t.increments("id").primary(); t.string("name"); })`,
    `(knex) => knex.schema.dropTableIfExists("notes")`
  ),
  // Data a migration writes must not end up in the dump, so its absence proves the dump was used.
  "20000101000001_record_migration_run.js": migrationFile(
    `async (knex) => { await knex.schema.createTable("migration_runs", (t) => { t.string("marker"); }); await knex("migration_runs").insert({ marker: "inserted-by-migration" }); }`,
    `(knex) => knex.schema.dropTableIfExists("migration_runs")`
  ),
  "20000101000002_add_details_to_notes.js": migrationFile(
    `async (knex) => { await knex.schema.alterTable("notes", (t) => { t.integer("priority"); t.index(["name"], "notes_name_index"); }); await knex.raw("create view notes_view as select id, name from notes"); }`,
    `async (knex) => { await knex.raw("drop view notes_view"); await knex.schema.alterTable("notes", (t) => { t.dropIndex(["name"], "notes_name_index"); t.dropColumn("priority"); }); }`
  ),
};
const TRIGGER_MIGRATION = "20000101000003_uppercase_note_names.js";
const ARCHIVED_MIGRATION = "20000102000000_add_archived_to_notes.js";
const LABELS_MIGRATION = "20000103000000_create_labels.js";

const ARCHIVED_FILE = migrationFile(
  `(knex) => knex.schema.alterTable("notes", (t) => { t.boolean("archived"); })`,
  `(knex) => knex.schema.alterTable("notes", (t) => { t.dropColumn("archived"); })`
);
// A table of its own: SQLite cannot rebuild notes for an ALTER while notes_view refers to it.
const LABELS_FILE = migrationFile(
  `(knex) => knex.schema.createTable("labels", (t) => { t.increments("id").primary(); t.string("label"); })`,
  `(knex) => knex.schema.dropTableIfExists("labels")`
);

describe("tenant schema dumps", () => {
  for (const engine of loadEngines()) {
    const dialect = DIALECTS[engine.id];

    if (!dialect) {
      describe(engine.label, { skip: engine.skip }, () => {
        it("schema:dump:tenants explains that SQL Server has no schema dumps", () => {
          const project = createProject();
          try {
            const { base } = engine.config(project, "tenora_dump_unused");
            project.writeConfig({ base, tenant: { migrationsDir: "migrations/tenants" } });
            const result = assertFailed(project.tenora(["schema:dump:tenants"]));
            assert.match(result.output, /schema dumps need .*other than SQL Server/);
          } finally {
            project.remove();
          }
        });
      });
      continue;
    }

    const toolMissing = engine.skip ? undefined : missingDumpTool(dialect);
    // In CI a missing tool must fail the run, never quietly skip the database.
    const skip = engine.skip || (toolMissing && !process.env.CI ? toolMissing : false);

    describe(engine.label, { skip }, () => {
      const run = randomBytes(3).toString("hex");
      const baseDb = `sd_${run}_base`;
      const tenants = {
        before: `sd_${run}_before`,
        fromDump: `sd_${run}_dump`,
        afterPrune: `sd_${run}_pruned`,
        lagging: `sd_${run}_lag`,
      };
      const userOf = (tenantId) => `user_${tenantId}`;
      const project = createProject();
      const dumpFile = project.path("migrations/schema", `tenant-${dialect}.sql`);
      const connections = new Map();
      let admin;

      const cli = (args) => project.tenora(args);

      const configWith = (root) => {
        const { base, tenant } = engine.config(project, baseDb);
        return {
          base: { ...base, migrationsDir: `${root}migrations/base` },
          tenant: { ...tenant, migrationsDir: `${root}migrations/tenants`, seedsDir: `${root}seeds/tenants` },
        };
      };

      const createTenant = async (tenantId, tenantOptions = {}) => {
        const config = configWith(`${project.dir}/`);
        const manager = createTenoraFactory({ ...config, tenant: { ...config.tenant, ...tenantOptions } });
        try {
          await manager.createTenantDb(tenantId, engine.perTenantUsers ? TENANT_PASSWORD : undefined);
        } finally {
          await manager.destroyAll();
        }
      };

      /** An independent connection used only to observe what Tenora did. */
      const observe = (database) => {
        const location = engine.locate(project, database);
        if (!connections.has(location)) connections.set(location, knex(engine.knexConfig(location)));
        return connections.get(location);
      };

      const appliedMigrations = async (tenantId) =>
        (await observe(tenantId)("knex_migrations").select("name").orderBy("id")).map((row) => row.name);

      const writeMigration = (name, content) => project.write(`migrations/tenants/${name}`, content);

      before(() => {
        for (const [name, content] of Object.entries(MIGRATIONS)) writeMigration(name, content);
        const trigger = TRIGGERS[dialect === "mariadb" ? "mysql" : dialect];
        writeMigration(TRIGGER_MIGRATION, migrationFile(trigger.up, trigger.down));
        project.write("seeds/tenants/notes.js", `export const seed = async (knex) => { await knex("notes").insert({ name: "seeded" }); };\n`);
        project.writeConfig(configWith(""));
        if (engine.server) admin = knex(engine.knexConfig(undefined));
        assertOk(cli(["migrate", "--create-base"]));
        assertOk(cli(["migrate"]));
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

      it("without a dump, createTenantDb runs every migration, as before", async () => {
        await createTenant(tenants.before);
        const runs = await observe(tenants.before)("migration_runs").select("marker");
        assert.deepEqual(runs, [{ marker: "inserted-by-migration" }]);
      });

      it("--check fails when there is no dump yet", () => {
        const result = assertFailed(cli(["schema:dump:tenants", "--check"]));
        assert.match(result.output, /there is no schema dump/);
      });

      it("schema:dump:tenants writes the structure and the migrations it contains, but no data", () => {
        const result = assertOk(cli(["schema:dump:tenants"]));
        assert.match(result.stdout, /4 migrations/);
        const dump = fs.readFileSync(dumpFile, "utf8");
        for (const name of [...Object.keys(MIGRATIONS), TRIGGER_MIGRATION]) {
          assert.ok(dump.includes(`-- migration: ${name}`), `${name} is not listed`);
        }
        assert.ok(!dump.includes("inserted-by-migration"), "rows written by a migration leaked into the dump");
        assert.ok(!dump.includes("seeded"), "seed data leaked into the dump");
      });

      it("--check fails once a migration is newer than the dump", () => {
        writeMigration(ARCHIVED_MIGRATION, ARCHIVED_FILE);
        const result = assertFailed(cli(["schema:dump:tenants", "--check"]));
        assert.match(result.output, new RegExp(`out of date.*${ARCHIVED_MIGRATION}`));
      });

      it("createTenantDb loads the dump, then runs only the newer migrations and the seeds", async () => {
        await createTenant(tenants.fromDump);
        const db = observe(tenants.fromDump);

        assert.deepEqual(await db("migration_runs").select("marker"), [], "the migrations ran instead of the dump");
        assert.deepEqual(await appliedMigrations(tenants.fromDump), [
          ...Object.keys(MIGRATIONS),
          TRIGGER_MIGRATION,
          ARCHIVED_MIGRATION,
        ]);
        assert.ok(await db.schema.hasColumn("notes", "archived"), "the newer migration did not run");
        assert.deepEqual((await db("notes").select("name")).map((row) => row.name), ["SEEDED"]);

        await db("notes").insert({ name: "from the test" });
        assert.deepEqual((await db("notes_view").select("name").orderBy("id")).map((row) => row.name), ["SEEDED", "FROM THE TEST"]);

        if (dialect === "postgres") {
          const [{ tableowner }] = (
            await db.raw("select tableowner from pg_tables where tablename = 'notes'")
          ).rows;
          assert.equal(tableowner, userOf(tenants.fromDump), "the tenant user should own its tables, as with migrations");
        }
      });

      it("a tenant built from the dump has the same structure as one built by migrations", async () => {
        const result = assertOk(cli(["migrate:tenants"]));
        assert.match(result.stdout, new RegExp(`Tenant ${tenants.before}: ${ARCHIVED_MIGRATION}`));
        assert.match(result.stdout, new RegExp(`Tenant ${tenants.fromDump}: up to date`));

        for (const table of ["notes", "migration_runs", "notes_view"]) {
          assert.deepEqual(
            await observe(tenants.fromDump)(table).columnInfo(),
            await observe(tenants.before)(table).columnInfo(),
            table
          );
        }
        assert.deepEqual(await appliedMigrations(tenants.fromDump), await appliedMigrations(tenants.before));
      });

      it("schema:dump:tenants again brings the dump up to date", () => {
        assert.match(assertOk(cli(["schema:dump:tenants"])).stdout, /5 migrations/);
        assert.match(assertOk(cli(["schema:dump:tenants", "--check"])).stdout, /is up to date/);
      });

      it("--prune deletes the migration files the dump contains", () => {
        const result = assertOk(cli(["schema:dump:tenants", "--prune"]));
        assert.match(result.stdout, new RegExp(`Pruned .*${ARCHIVED_MIGRATION}`));
        assert.deepEqual(project.list("migrations/tenants"), []);
        assert.match(assertOk(cli(["schema:dump:tenants", "--check"])).stdout, /is up to date/);
      });

      it("existing tenants keep migrating after the prune", () => {
        const result = assertOk(cli(["migrate:tenants"]));
        for (const tenantId of [tenants.before, tenants.fromDump]) {
          assert.match(result.stdout, new RegExp(`Tenant ${tenantId}: up to date`));
        }
      });

      it("createTenantDb still builds complete tenants after the prune", async () => {
        await createTenant(tenants.afterPrune);
        assert.deepEqual(await appliedMigrations(tenants.afterPrune), await appliedMigrations(tenants.before));
        assert.ok(await observe(tenants.afterPrune).schema.hasColumn("notes", "archived"));
      });

      it("new migrations after the prune apply to every tenant and roll back", async () => {
        writeMigration(LABELS_MIGRATION, LABELS_FILE);
        const all = [tenants.before, tenants.fromDump, tenants.afterPrune];

        const migrated = assertOk(cli(["migrate:tenants"]));
        for (const tenantId of all) {
          assert.match(migrated.stdout, new RegExp(`Tenant ${tenantId}: ${LABELS_MIGRATION}`));
        }
        const rolledBack = assertOk(cli(["rollback:tenants"]));
        for (const tenantId of all) {
          assert.match(rolledBack.stdout, new RegExp(`Tenant ${tenantId}: ${LABELS_MIGRATION}`));
          assert.equal(await observe(tenantId).schema.hasTable("labels"), false, tenantId);
        }
        assertOk(cli(["migrate:tenants"]));
      });

      it("rolling back into a pruned migration fails with a clear error", () => {
        assertOk(cli(["rollback:tenants"]));
        const result = assertFailed(cli(["rollback:tenants"]));
        assert.match(result.output, /was pruned into the schema dump .* cannot be rolled back/);
        assertOk(cli(["migrate:tenants"]));
      });

      it("a tenant that never ran a pruned migration gets a clear error", async () => {
        await createTenant(tenants.lagging);
        await observe(tenants.lagging)("knex_migrations").where({ name: ARCHIVED_MIGRATION }).delete();

        const result = assertFailed(cli(["migrate:tenants"]));
        assert.match(result.output, new RegExp(`never ran migration "${ARCHIVED_MIGRATION}".*Restore the file`));

        assertOk(cli(["drop:tenant", tenants.lagging, "--force"]));
      });

      it("dumping after the prune starts from the previous dump", () => {
        assert.match(assertOk(cli(["schema:dump:tenants"])).stdout, /6 migrations/);
        const dump = fs.readFileSync(dumpFile, "utf8");
        assert.ok(dump.includes(`-- migration: ${ARCHIVED_MIGRATION}`));
        assert.ok(dump.includes(`-- migration: ${LABELS_MIGRATION}`));
        assert.ok(!dump.includes("inserted-by-migration"));
      });
    });
  }
});
