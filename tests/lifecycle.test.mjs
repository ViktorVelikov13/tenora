import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import knex from "knex";
import { Model, sql } from "../packages/orm/dist/index.js";
import {
  createTenantResolver,
  createTenoraFactory,
  decryptPassword,
} from "../packages/multi-tenant/dist/index.js";
import { loadEngines } from "./support/engines.mjs";
import { assertFailed, assertOk, createdFile, createProject } from "./support/project.mjs";

const TENORA_KEY = "tenora-test-cipher-key";
// "Enc!Pw#2-tenora" encrypted with TENORA_KEY by crypto-js 4.2.0, as Tenora 0.3 stored it.
const LEGACY_ENC_PASSWORD = "U2FsdGVkX18DyfwYG55+0AtEmJVcMdiLWW/6SjVlV1g=";
const REGISTRY = "tenora_tenants";

const seedInserting = (table, column, value) =>
  `export const seed = async ({ db }) => {\n  await db.table("${table}").insert({ ${column}: "${value}" });\n};\n`;

const tableCreating = (table) =>
  `export const up = ({ schema }) =>\n  schema.create("${table}", (t) => {\n    t.increments("id");\n    t.string("name").nullable();\n  });\n\nexport const down = ({ schema }) => schema.dropIfExists("${table}");\n`;

/** The login a Tenora connection is really using. */
const currentUser = async (engine, db) => (await db.raw(sql`${sql.raw(engine.currentUserSql)}`))[0].name;

describe("configuration options against a real database", () => {
  for (const engine of loadEngines()) {
    describe(engine.label, { skip: engine.skip }, () => {
      const run = randomBytes(3).toString("hex");
      const baseDb = `tenora_e2e_${run}_opts`;
      const shared = `tenora_e2e_${run}_reg`;
      const withUser = `tenora_e2e_${run}_usr`;
      const named = `tenora_e2e_${run}_nam`;
      const renamed = `tenora_e2e_${run}_renamed`;
      const prefixedUser = `t_${withUser}`;
      const registry = {
        table: "custom_tenants",
        idColumn: "tenant_id",
        passwordColumn: "secret",
        encryptedPasswordColumn: "sealed_secret",
        createdAtColumn: "added_at",
        updatedAtColumn: "changed_at",
      };

      const project = createProject();
      let admin;
      let baseKnex;

      const options = (root, tenantOptions = {}) => {
        const { base, tenant } = engine.config(project, baseDb);
        return {
          base: {
            ...base,
            migrationsDir: `${root}migrations/base`,
            pool: { min: 0, max: 2, acquireTimeoutMillis: 3_000 },
          },
          tenant: { ...tenant, userPrefix: "t_", ...tenantOptions },
          registry,
        };
      };

      const provision = async (tenantId, password, tenantOptions) => {
        const manager = createTenoraFactory(options(`${project.dir}/`, tenantOptions));
        try {
          await manager.createTenantDb(tenantId, password);
        } finally {
          await manager.destroyAll();
        }
      };

      const drop = async (tenantId, tenantOptions) => {
        const manager = createTenoraFactory(options(`${project.dir}/`, tenantOptions));
        try {
          await manager.dropTenantDb(tenantId);
        } finally {
          await manager.destroyAll();
        }
      };

      before(() => {
        project.writeConfig(options(""));
        if (engine.server) admin = knex(engine.knexConfig(undefined));
      });

      after(async () => {
        await baseKnex?.destroy();
        if (admin) {
          await engine.cleanup(admin, {
            databases: [baseDb, shared, withUser, named, renamed],
            users: [prefixedUser],
          });
          await admin.destroy();
        }
        project.remove();
      });

      it("registry options rename the generated table and columns, and tenants land there", async () => {
        assertOk(project.tenora(["migrate", "--create-base"]));
        assertOk(project.tenora(["migrate"]));
        baseKnex = knex(engine.knexConfig(engine.locate(project, baseDb)));

        await provision(shared);

        assert.equal(await baseKnex.schema.hasTable(REGISTRY), false);
        for (const column of Object.values(registry).slice(1)) {
          assert.equal(await baseKnex.schema.hasColumn(registry.table, column), true, column);
        }
        const [record] = await baseKnex(registry.table).where({ tenant_id: shared });
        assert.equal(record.tenant_id, shared);
      });

      it("tenant.userPrefix names the per-tenant user, and drop removes that user", { skip: !engine.perTenantUsers }, async () => {
        await provision(withUser, "Prefixed!Pw#3-tenora");
        assert.equal(await engine.userExists(admin, prefixedUser), true);

        await drop(withUser);

        assert.equal(await engine.userExists(admin, prefixedUser), false);
      });

      it('the "sqlserver" client alias reaches SQL Server', { skip: engine.id !== "mssql" }, async () => {
        const aliased = options("");
        aliased.base.client = "sqlserver";
        project.writeConfig(aliased, "sqlserver.config.js");

        assert.match(
          assertOk(project.tenora(["migrate", "--create-base", "--config", "sqlserver.config.js"])).stdout,
          /Base up to date/
        );
      });

      it("tenant.databaseName chooses the database that is created", async () => {
        const databaseName = () => (engine.perTenantUsers ? renamed : `${renamed}.sqlite`);

        await provision(named, undefined, { databaseName });

        const exists = (name) => engine.databaseExists(admin, engine.locate(project, name));
        assert.equal(await exists(renamed), true, "the configured name was not created");
        assert.equal(await exists(named), false, "the tenant id was used as the name instead");

        await drop(named, { databaseName });

        assert.equal(await exists(renamed), false, "drop did not use the configured name");
      });
    });
  }
});

describe("Postgres with a non-superuser admin, as on managed hosting", () => {
  const engine = loadEngines().find((candidate) => candidate.id === "postgres");

  describe(engine.label, { skip: engine.skip }, () => {
    const run = randomBytes(3).toString("hex");
    const baseDb = `tenora_e2e_${run}_lim`;
    const tenantId = `tenora_e2e_${run}_ten`;
    const adminUser = `tenora_e2e_${run}_admin`;
    const adminPassword = "Limited!Pw#4-tenora";
    const project = createProject();
    let admin;

    const config = () => {
      const { base, tenant } = engine.config(project, baseDb);
      return {
        base: { ...base, user: adminUser, password: adminPassword, migrationsDir: `${project.dir}/migrations/base` },
        tenant: { ...tenant, migrationsDir: `${project.dir}/migrations/tenants` },
      };
    };

    before(async () => {
      admin = knex(engine.knexConfig(undefined));
      await admin.raw(`create role "${adminUser}" login createdb createrole password '${adminPassword}'`);
      project.writeConfig(config());
      project.write("migrations/tenants/20260101000000_notes.js", tableCreating("notes"));
    });

    after(async () => {
      await engine.cleanup(admin, {
        databases: [baseDb, tenantId],
        users: [`user_${tenantId}`, adminUser],
      });
      await admin.destroy();
      project.remove();
    });

    it("creates a tenant whose user can migrate, then drops it again", async () => {
      assertOk(project.tenora(["migrate", "--create-base"]));
      assertOk(project.tenora(["migrate"]));

      const manager = createTenoraFactory(config());
      try {
        await manager.createTenantDb(tenantId, "Tenant!Pw#5-tenora");
        const tenantDb = manager.getTenant(tenantId, "Tenant!Pw#5-tenora");
        assert.equal(await tenantDb.schema.hasTable("notes"), true);
        assert.equal(await currentUser(engine, tenantDb), `user_${tenantId}`);
      } finally {
        await manager.destroyAll();
      }

      assertOk(project.tenora(["drop:tenant", tenantId, "--force"]));

      assert.equal(await engine.databaseExists(admin, tenantId), false);
      assert.equal(await engine.userExists(admin, `user_${tenantId}`), false);
    });
  });
});

describe("full lifecycle against a real database", () => {
  for (const engine of loadEngines()) {
    describe(engine.label, { skip: engine.skip }, () => {
      const run = randomBytes(3).toString("hex");
      const baseDb = `tenora_e2e_${run}_base`;
      const tenants = {
        plain: `tenora_e2e_${run}_plain`,
        enc: `tenora_e2e_${run}_enc`,
        shared: `tenora_e2e_${run}_shared`,
      };
      const orphan = `tenora_e2e_${run}_orphan`;
      const unrelated = `tenora_e2e_${run}_other`;
      const passwords = { plain: "Plain'Pw#1-tenora", enc: "Enc!Pw#2-tenora" };
      const allTenants = Object.values(tenants);
      const userOf = (tenantId) => `user_${tenantId}`;

      const project = createProject();
      const connections = new Map();
      let admin;

      const dirs = (root = "") => ({
        base: { migrationsDir: `${root}migrations/base`, seedsDir: `${root}seeds/base` },
        tenant: { migrationsDir: `${root}migrations/tenants`, seedsDir: `${root}seeds/tenants` },
      });

      const configWith = (root) => {
        const { base, tenant } = engine.config(project, baseDb);
        const paths = dirs(root);
        return { base: { ...base, ...paths.base }, tenant: { ...tenant, ...paths.tenant } };
      };

      const absoluteConfig = () => configWith(`${project.dir}/`);

      const cli = (args) => project.tenora(args, { env: { TENORA_KEY } });

      /** An independent connection used only to observe what Tenora did. */
      const observe = (database) => {
        const location = engine.locate(project, database);
        if (!connections.has(location)) {
          connections.set(location, knex(engine.knexConfig(location)));
        }
        return connections.get(location);
      };

      const databaseExists = (name) =>
        engine.databaseExists(admin, engine.locate(project, name));

      const forget = async (database) => {
        const location = engine.locate(project, database);
        await connections.get(location)?.destroy();
        connections.delete(location);
      };

      const assertTenantGone = async (tenantId) => {
        assert.equal(await databaseExists(tenantId), false, "database still exists");
        if (engine.perTenantUsers) {
          assert.equal(await engine.userExists(admin, userOf(tenantId)), false, "user still exists");
        }
        const records = await observe(baseDb)(REGISTRY).where({ id: tenantId });
        assert.equal(records.length, 0, "registry entry still exists");
      };

      const rows = (database, table) => observe(database)(table).select();

      const withFactory = async (fn) => {
        const manager = createTenoraFactory(absoluteConfig());
        try {
          return await fn(manager);
        } finally {
          await manager.destroyAll();
        }
      };

      before(() => {
        project.writeConfig(configWith(""));
        if (engine.server) admin = knex(engine.knexConfig(undefined));
      });

      after(async () => {
        for (const connection of connections.values()) await connection.destroy();
        if (admin) {
          await engine.cleanup(admin, {
            databases: [baseDb, ...allTenants, orphan, unrelated],
            users: [...allTenants, orphan].map(userOf),
          });
          await admin.destroy();
        }
        project.remove();
        delete process.env.TENORA_KEY;
      });

      it("migrate --create-base creates the base database and writes the registry migration", async () => {
        assert.equal(await databaseExists(baseDb), false, "base database must not exist yet");

        const result = assertOk(cli(["migrate", "--create-base"]));

        assert.match(result.stdout, /created base database/);
        assert.match(result.stdout, /created tenant registry migration/);
        assert.equal(await databaseExists(baseDb), true, "base database was not created");
        assert.equal(project.list("migrations/base").length, 1);
        assert.equal(
          await observe(baseDb).schema.hasTable(REGISTRY),
          false,
          "the first run must only write the migration, not apply it"
        );
      });

      it("migrate applies the registry migration on the second run", async () => {
        const [migration] = project.list("migrations/base");

        const result = assertOk(cli(["migrate"]));

        assert.match(result.stdout, new RegExp(migration.replace(/\.js$/, "")));
        assert.equal(await observe(baseDb).schema.hasTable(REGISTRY), true);
        for (const column of ["id", "password", "encrypted_password", "created_at", "updated_at"]) {
          assert.equal(await observe(baseDb).schema.hasColumn(REGISTRY, column), true, column);
        }
        assert.equal((await rows(baseDb, "tenora_migrations")).length, 1);
        assert.equal(await observe(baseDb).schema.hasTable("knex_migrations"), false);
      });

      it("migrate reports up to date when nothing is pending", () => {
        assert.match(assertOk(cli(["migrate"])).stdout, /Base up to date/);
      });

      it("--create-base leaves an existing base database and its data alone", async () => {
        const result = assertOk(cli(["migrate", "--create-base"]));

        assert.doesNotMatch(result.stdout, /created base database/);
        assert.equal((await rows(baseDb, "tenora_migrations")).length, 1);
      });

      it("make:migration output is applied by migrate, and migrate:base does the same", async () => {
        assertOk(cli(["make:migration", "create_products"]));
        assert.match(assertOk(cli(["migrate"])).stdout, /create_products/);
        assert.equal(await observe(baseDb).schema.hasTable("products"), true);

        assertOk(cli(["make:migration:base", "create_orders"]));
        assert.match(assertOk(cli(["migrate:base"])).stdout, /create_orders/);
        assert.equal(await observe(baseDb).schema.hasTable("orders"), true);
      });

      it("rollback undoes only the last batch, and rollback:base undoes the one before", async () => {
        assert.match(assertOk(cli(["rollback"])).stdout, /create_orders/);
        assert.equal(await observe(baseDb).schema.hasTable("orders"), false);
        assert.equal(await observe(baseDb).schema.hasTable("products"), true);

        assert.match(assertOk(cli(["rollback:base"])).stdout, /create_products/);
        assert.equal(await observe(baseDb).schema.hasTable("products"), false);
        assert.equal(await observe(baseDb).schema.hasTable(REGISTRY), true);
      });

      it("migrate re-applies rolled back migrations", async () => {
        assertOk(cli(["migrate"]));
        assert.equal(await observe(baseDb).schema.hasTable("products"), true);
        assert.equal(await observe(baseDb).schema.hasTable("orders"), true);
      });

      it("seed:run and seed:run:base really insert rows into the base database", async () => {
        const file = createdFile(project, assertOk(cli(["make:seed", "products"])));
        project.write(file, seedInserting("products", "created_at", "2026-01-02 03:04:05"));

        assert.match(assertOk(cli(["seed:run"])).stdout, /products/);
        assert.equal((await rows(baseDb, "products")).length, 1);

        assert.match(assertOk(cli(["seed:run:base"])).stdout, /products/);
        assert.equal((await rows(baseDb, "products")).length, 2);
      });

      it("createTenantDb creates the database and user, migrates, seeds and registers it", async () => {
        const migration = createdFile(
          project,
          assertOk(cli(["make:migration:tenants", "create_notes_table"]))
        );
        // Migration timestamps have one-second resolution, and later tests add a migration that
        // must sort after this one on a fresh database.
        project.delete(migration);
        project.write("migrations/tenants/20000101000000_create_notes_table.js", tableCreating("notes"));
        const seed = createdFile(project, assertOk(cli(["make:seed:tenants", "notes"])));
        project.write(seed, seedInserting("notes", "name", "seeded"));
        assert.equal(await databaseExists(tenants.plain), false);

        await withFactory((manager) => manager.createTenantDb(tenants.plain, passwords.plain));

        assert.equal(await databaseExists(tenants.plain), true, "tenant database was not created");
        if (engine.perTenantUsers) {
          assert.equal(await engine.userExists(admin, userOf(tenants.plain)), true);
        }
        assert.equal(await observe(tenants.plain).schema.hasTable("notes"), true);
        assert.deepEqual(
          (await rows(tenants.plain, "notes")).map((row) => row.name),
          ["seeded"]
        );
        const [record] = await observe(baseDb)(REGISTRY).where({ id: tenants.plain });
        assert.equal(record.password, passwords.plain);
        assert.equal(record.encrypted_password, null);
      });

      it("createTenantDb stores the password encrypted when TENORA_KEY is set", async () => {
        process.env.TENORA_KEY = TENORA_KEY;
        await withFactory((manager) => manager.createTenantDb(tenants.enc, passwords.enc));

        const [record] = await observe(baseDb)(REGISTRY).where({ id: tenants.enc });
        assert.equal(record.password, null, "plaintext password must not be stored");
        assert.match(record.encrypted_password, /^tenora:v1:/);
        assert.equal(decryptPassword(record.encrypted_password, TENORA_KEY), passwords.enc);
      });

      it("createTenantDb without a password uses the base credentials and creates no user", async () => {
        await withFactory((manager) => manager.createTenantDb(tenants.shared));

        assert.equal(await databaseExists(tenants.shared), true);
        if (engine.perTenantUsers) {
          assert.equal(await engine.userExists(admin, userOf(tenants.shared)), false);
        }
        const [record] = await observe(baseDb)(REGISTRY).where({ id: tenants.shared });
        assert.equal(record.password, null);
        assert.equal(record.encrypted_password, null);
      });

      it("createTenantDb refuses a tenant whose database already exists", { skip: engine.id.includes("sqlite") || engine.id === "mssql" }, async () => {
        await withFactory((manager) =>
          assert.rejects(manager.createTenantDb(tenants.plain, passwords.plain), /already exists/)
        );
      });

      it("createTenantDb on an existing SQL Server tenant updates its registry entry", { skip: engine.id !== "mssql" }, async () => {
        await withFactory((manager) => manager.createTenantDb(tenants.plain, passwords.plain));

        const records = await observe(baseDb)(REGISTRY).where({ id: tenants.plain });
        assert.equal(records.length, 1);
      });

      it("getTenant connects as the per-tenant user, and the password is really checked", { skip: !engine.perTenantUsers }, async () => {
        await withFactory(async (manager) => {
          const tenantDb = manager.getTenant(tenants.plain, passwords.plain);
          assert.equal(await currentUser(engine, tenantDb), userOf(tenants.plain));
        });

        const wrongPassword = knex(
          engine.knexConfig(tenants.plain, { user: userOf(tenants.plain), password: "wrong" })
        );
        try {
          await assert.rejects(wrongPassword.raw("select 1"));
        } finally {
          await wrongPassword.destroy();
        }
      });

      it("keeps tenant data isolated", async () => {
        await observe(tenants.plain)("notes").insert({ name: "only-in-plain" });

        const inPlain = (await rows(tenants.plain, "notes")).map((row) => row.name);
        const inEnc = (await rows(tenants.enc, "notes")).map((row) => row.name);
        assert.ok(inPlain.includes("only-in-plain"));
        assert.ok(!inEnc.includes("only-in-plain"));
        assert.equal(await observe(baseDb).schema.hasTable("notes"), false);
      });

      it("a tenant's user cannot read another tenant's database", { skip: !engine.perTenantUsers }, async () => {
        const intruder = knex(
          engine.knexConfig(tenants.enc, {
            user: userOf(tenants.plain),
            password: passwords.plain,
          })
        );
        try {
          await assert.rejects(intruder("notes").select());
        } finally {
          await intruder.destroy();
        }
      });

      it("migrate:tenants migrates every tenant in the registry", async () => {
        assertOk(cli(["make:migration:tenants", "add_priority_to_notes"]));

        const result = assertOk(cli(["migrate:tenants"]));

        for (const tenantId of allTenants) {
          assert.match(result.stdout, new RegExp(`Tenant ${tenantId}: .*add_priority_to_notes`));
          assert.equal(await observe(tenantId).schema.hasColumn("notes", "priority"), true, tenantId);
        }
        assert.equal(await observe(baseDb).schema.hasTable("notes"), false);
      });

      it("migrate:tenants reports up to date when nothing is pending", () => {
        const result = assertOk(cli(["migrate:tenants"]));
        for (const tenantId of allTenants) {
          assert.match(result.stdout, new RegExp(`Tenant ${tenantId}: up to date`));
        }
      });

      it("migrate:tenants still connects with a password stored by Tenora 0.3", { skip: !engine.perTenantUsers }, async () => {
        const entry = () => observe(baseDb)(REGISTRY).where({ id: tenants.enc });
        const [record] = await entry();
        await entry().update({ encrypted_password: LEGACY_ENC_PASSWORD });
        try {
          const result = assertOk(cli(["migrate:tenants"]));
          assert.match(result.stdout, new RegExp(`Tenant ${tenants.enc}: up to date`));
        } finally {
          await entry().update({ encrypted_password: record.encrypted_password });
        }
      });

      it("migrate:tenants with the wrong TENORA_KEY fails with a clear error", () => {
        const result = assertFailed(project.tenora(["migrate:tenants"], { env: { TENORA_KEY: "not-the-key" } }));
        assert.match(result.output, /could not decrypt the tenant password/);
      });

      it("rollback:tenants undoes the last batch for every tenant and keeps earlier ones", async () => {
        const result = assertOk(cli(["rollback:tenants"]));

        for (const tenantId of allTenants) {
          assert.match(result.stdout, new RegExp(`Tenant ${tenantId}: .*add_priority_to_notes`));
          assert.equal(await observe(tenantId).schema.hasColumn("notes", "priority"), false, tenantId);
          assert.equal(await observe(tenantId).schema.hasTable("notes"), true, tenantId);
        }
      });

      it("seed:run:tenants inserts rows into every tenant", async () => {
        const before = await Promise.all(allTenants.map((id) => rows(id, "notes")));

        const result = assertOk(cli(["seed:run:tenants"]));

        for (const [index, tenantId] of allTenants.entries()) {
          assert.match(result.stdout, new RegExp(`Tenant ${tenantId}: `));
          const after = await rows(tenantId, "notes");
          assert.equal(after.length, before[index].length + 1, tenantId);
        }
      });

      it("createTenantResolver attaches a connection bound to the requested tenant", async () => {
        await withFactory(async (manager) => {
          const resolve = createTenantResolver({
            manager,
            tenantId: (req) => req.headers["x-tenant-id"],
            passwordProvider: () => passwords.plain,
          });
          const req = { headers: { "x-tenant-id": tenants.plain } };

          await resolve(req);

          assert.equal(req.tenantId, tenants.plain);
          const names = await req.db.table("notes").pluck("name");
          assert.ok(names.includes("only-in-plain"));
        });
      });

      it("works with models on a tenant connection", async () => {
        class Note extends Model {
          static table = "notes";
          static timestamps = false;
          static fillable = ["name"];
        }

        await withFactory(async (manager) => {
          const tenantDb = manager.getTenant(tenants.enc, passwords.enc);
          const created = await Note.on(tenantDb).create({ name: "via-model" });
          const fetched = await Note.on(tenantDb).find(created.id);
          assert.equal(fetched.name, "via-model");
        });
      });

      it("drop:tenant without --force changes nothing", async () => {
        assertFailed(cli(["drop:tenant", tenants.shared]));

        assert.equal(await databaseExists(tenants.shared), true);
        assert.equal((await observe(baseDb)(REGISTRY).where({ id: tenants.shared })).length, 1);
      });

      it("drop:tenant --force removes the database, its user and its registry entry", async () => {
        await rows(tenants.plain, "notes"); // leaves a connection open, which must not block the drop

        const result = assertOk(cli(["drop:tenant", tenants.plain, "--force"]));

        assert.match(result.stdout, new RegExp(`Tenant ${tenants.plain}: dropped`));
        await forget(tenants.plain);
        await assertTenantGone(tenants.plain);
      });

      it("drop:tenant leaves the base database and other tenants alone", async () => {
        assert.ok((await rows(tenants.enc, "notes")).length > 0);
        assert.ok((await rows(baseDb, "products")).length > 0);

        const result = assertOk(cli(["migrate:tenants"]));

        assert.doesNotMatch(result.stdout, new RegExp(tenants.plain));
        assert.match(result.stdout, new RegExp(tenants.enc));
      });

      it("a dropped tenant can be created again and starts empty", async () => {
        await withFactory((manager) => manager.createTenantDb(tenants.plain, passwords.plain));

        assert.deepEqual(
          (await rows(tenants.plain, "notes")).map((row) => row.name),
          ["seeded"]
        );
      });

      it("dropTenantDb closes the manager's own connection and removes the tenant", async () => {
        await withFactory(async (manager) => {
          const cached = manager.getTenant(tenants.enc, passwords.enc);
          await cached.table("notes").get();
          await forget(tenants.enc);

          await manager.dropTenantDb(tenants.enc);

          assert.notEqual(manager.getTenant(tenants.enc), cached, "the old connection stayed cached");
        });

        await assertTenantGone(tenants.enc);
      });

      it("drop:tenant refuses a database that is not a registered tenant", async () => {
        await engine.createDatabase(admin, engine.locate(project, unrelated));

        const result = assertFailed(cli(["drop:tenant", unrelated, "--force"]));

        assert.match(result.output, /not in the registry/);
        assert.equal(await databaseExists(unrelated), true);
      });

      it("drop:tenant never drops the base database, even with --allow-unregistered", async () => {
        const result = assertFailed(cli(["drop:tenant", baseDb, "--force", "--allow-unregistered"]));

        assert.match(result.output, /refusing to drop protected database/);
        assert.equal(await databaseExists(baseDb), true);
      });

      it("drop:tenant never drops a system database", { skip: !engine.perTenantUsers }, async () => {
        const result = assertFailed(
          cli(["drop:tenant", engine.adminDatabase, "--force", "--allow-unregistered"])
        );

        assert.match(result.output, /refusing to drop protected database/);
        assert.equal(await engine.databaseExists(admin, engine.adminDatabase), true);
      });

      it("--allow-unregistered clears a half-created tenant so it can be created again", async () => {
        const broken = "migrations/tenants/99999999999999_broken.js";
        project.write(
          broken,
          'export const up = () => { throw new Error("boom"); };\nexport const down = () => {};\n'
        );
        await withFactory((manager) =>
          assert.rejects(manager.createTenantDb(orphan, passwords.plain), /boom/)
        );
        project.delete(broken);
        assert.equal(await databaseExists(orphan), true);
        assert.equal((await observe(baseDb)(REGISTRY).where({ id: orphan })).length, 0);

        assert.match(
          assertFailed(cli(["drop:tenant", orphan, "--force"])).output,
          /not in the registry/
        );
        assertOk(cli(["drop:tenant", orphan, "--force", "--allow-unregistered"]));
        await assertTenantGone(orphan);

        await withFactory((manager) => manager.createTenantDb(orphan, passwords.plain));
        assert.equal(await databaseExists(orphan), true);
      });
    });
  }
});
