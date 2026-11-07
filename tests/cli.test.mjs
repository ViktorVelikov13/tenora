import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  assertFailed,
  assertOk,
  createdFile,
  createProject,
  MULTI_TENANT_BIN,
} from "./support/project.mjs";

const projects = [];

const newProject = (options) => {
  const project = createProject(options);
  projects.push(project);
  return project;
};

const sqliteConfig = {
  base: {
    client: "sqlite3",
    database: "data/base.sqlite",
    migrationsDir: "migrations/base",
    seedsDir: "seeds/base",
  },
  tenant: { migrationsDir: "migrations/tenants", seedsDir: "seeds/tenants" },
};

const sqliteProject = (options) => {
  const project = newProject(options);
  project.writeConfig(sqliteConfig);
  return project;
};

after(() => {
  for (const project of projects) project.remove();
});

describe("command surface", () => {
  const commands = [
    "migrate:base",
    "migrate",
    "rollback:base",
    "rollback",
    "migrate:tenants",
    "rollback:tenants",
    "drop:tenant",
    "make:migration",
    "make:migration:base",
    "make:migration:tenants",
    "make:seed",
    "make:seed:base",
    "make:seed:tenants",
    "seed:run:base",
    "seed:run",
    "seed:run:tenants",
    "list",
  ];

  it("both published binaries expose every command", () => {
    const project = newProject();
    for (const bin of [undefined, MULTI_TENANT_BIN]) {
      const { stdout } = assertOk(project.tenora(["list"], bin ? { bin } : {}));
      for (const command of commands) {
        assert.match(stdout, new RegExp(`^\\s+${command}\\b`, "m"), command);
      }
    }
  });

  it("the multi-tenant binary runs real commands too", () => {
    const project = sqliteProject();
    assertOk(project.tenora(["migrate", "--create-base"], { bin: MULTI_TENANT_BIN }));
    assert.match(
      assertOk(project.tenora(["migrate"], { bin: MULTI_TENANT_BIN })).stdout,
      /create_tenant_registry/
    );
  });
});

describe("migration templates", () => {
  const cases = [
    ["create_users", ['createTable("users"', 'dropTableIfExists("users")']],
    ["create_users_table", ['createTable("users"', 'dropTableIfExists("users")']],
    ["createInvoices", ['createTable("invoices"']],
    ["create_user_profiles", ['createTable("user_profiles"']],
    ["create_user_profiles_table", ['createTable("user_profiles"']],
    ["add_email_to_users", ['alterTable("users"', 't.string("email")', 't.dropColumn("email")']],
    ["add_email_to_users_table", ['alterTable("users"', 't.string("email")']],
    ["add_create_date_to_users", ['alterTable("users"', 't.string("create_date")']],
    [
      "add_first_name_and_last_name_to_users",
      ['t.string("first_name")', 't.string("last_name")'],
    ],
    ["remove_email_from_users", ['alterTable("users"', 't.dropColumn("email")', 't.string("email")']],
    ["drop_email_from_users", ['alterTable("users"', 't.dropColumn("email")']],
    ["drop_users_table", ["// TODO"]],
    ["backfill_legacy_data", ["// TODO"]],
  ];

  for (const [name, fragments] of cases) {
    it(`${name} produces the expected template`, () => {
      const project = sqliteProject();
      const file = createdFile(project, assertOk(project.tenora(["make:migration", name])));
      const body = project.read(file);
      for (const fragment of fragments) {
        assert.ok(body.includes(fragment), `missing ${fragment} in:\n${body}`);
      }
    });
  }
});

describe("template module format", () => {
  it("follows the project's package.json type", () => {
    const esm = sqliteProject();
    const cjs = sqliteProject({ type: "commonjs" });

    const esmFile = createdFile(esm, assertOk(esm.tenora(["make:migration", "create_a"])));
    const cjsFile = createdFile(cjs, assertOk(cjs.tenora(["make:migration", "create_a"])));

    assert.match(esm.read(esmFile), /^export const up/m);
    assert.match(cjs.read(cjsFile), /^exports\.up/m);
  });

  it("--esm and --cjs override detection for migrations and seeds", () => {
    const project = sqliteProject();

    const cjs = createdFile(project, assertOk(project.tenora(["make:migration", "create_a", "--cjs"])));
    assert.match(project.read(cjs), /^exports\.up/m);

    const seed = createdFile(project, assertOk(project.tenora(["make:seed", "a", "--cjs"])));
    assert.match(project.read(seed), /^exports\.seed/m);

    const esm = createdFile(project, assertOk(project.tenora(["make:seed", "b", "--esm"])));
    assert.match(project.read(esm), /^export const seed/m);
  });

  it("rejects --esm together with --cjs", () => {
    const project = sqliteProject();
    const result = assertFailed(project.tenora(["make:migration", "create_a", "--esm", "--cjs"]));
    assert.match(result.output, /choose only one/);
  });
});

describe("configuration", () => {
  it("finds tenora.config.mjs when tenora.config.js is missing", () => {
    const project = newProject();
    project.writeConfig(sqliteConfig, "tenora.config.mjs");
    assertOk(project.tenora(["make:migration", "create_a"]));
    assert.equal(project.list("migrations/base").length, 1);
  });

  it("honours --config", () => {
    const project = newProject();
    project.writeConfig(sqliteConfig, "config/custom.js");
    assertOk(project.tenora(["make:migration", "create_a", "--config", "config/custom.js"]));
    assert.equal(project.list("migrations/base").length, 1);
  });

  it("honours TENORA_CONFIG, and --config still wins over it", () => {
    const project = newProject();
    project.writeConfig(sqliteConfig, "config/from-env.js");
    project.writeConfig(
      { base: { ...sqliteConfig.base, migrationsDir: "migrations/other" } },
      "tenora.config.js"
    );
    const env = { TENORA_CONFIG: "config/from-env.js" };

    assertOk(project.tenora(["make:migration", "create_a"], { env }));
    assert.equal(project.list("migrations/base").length, 1);
    assert.equal(project.list("migrations/other").length, 0);

    assertOk(project.tenora(["make:migration", "create_b", "--config", "config/from-env.js"], { env }));
    assert.equal(project.list("migrations/base").length, 2);
  });

  it("fails with a clear message when no config exists", () => {
    const project = newProject();
    assert.match(assertFailed(project.tenora(["migrate"])).output, /no config found/);
  });

  it("fails when a required directory is not configured", () => {
    const project = newProject();
    project.writeConfig({ base: { client: "sqlite3", database: "data/base.sqlite" } });

    assert.match(
      assertFailed(project.tenora(["make:migration", "create_a"])).output,
      /base\.migrationsDir is required/
    );
    assert.match(
      assertFailed(project.tenora(["make:migration:tenants", "create_a"])).output,
      /tenant\.migrationsDir is required/
    );
    assert.match(
      assertFailed(project.tenora(["make:seed", "a"])).output,
      /base\.seedsDir is required/
    );
    assert.match(
      assertFailed(project.tenora(["make:seed:tenants", "a"])).output,
      /tenant\.seedsDir is required/
    );
    assert.match(
      assertFailed(project.tenora(["migrate"])).output,
      /base\.migrationsDir is required/
    );
  });
});

describe("edge cases and failures", () => {
  it("rollback with nothing applied says so", () => {
    const project = sqliteProject();
    assertOk(project.tenora(["migrate", "--create-base"]));
    assertOk(project.tenora(["migrate"]));
    assertOk(project.tenora(["rollback"]));
    assert.match(assertOk(project.tenora(["rollback"])).stdout, /Nothing to rollback/);
  });

  it("seed:run with no seed files says so", () => {
    const project = sqliteProject();
    project.write("seeds/base/.gitkeep", "");
    assert.match(
      assertOk(project.tenora(["seed:run", "--create-base"])).stdout,
      /No seeds executed/
    );
  });

  it("tenant commands fail clearly before the registry exists", () => {
    const project = sqliteProject();
    assertOk(project.tenora(["migrate", "--create-base"]));
    assert.match(
      assertFailed(project.tenora(["migrate:tenants"])).output,
      /Run 'tenora migrate' to create it/
    );
  });

  it("exits non-zero when a migration throws, and records nothing for it", () => {
    const project = sqliteProject();
    assertOk(project.tenora(["migrate", "--create-base"]));
    assertOk(project.tenora(["migrate"]));
    project.write(
      "migrations/base/99999999999999_broken.js",
      'export const up = () => { throw new Error("boom"); };\nexport const down = () => {};\n'
    );

    assert.match(assertFailed(project.tenora(["migrate"])).output, /boom/);
    assert.match(assertOk(project.tenora(["rollback"])).stdout, /create_tenant_registry/);
  });

  it("exits non-zero when the database server is unreachable", () => {
    const project = newProject();
    project.writeConfig({
      base: {
        client: "pg",
        host: "127.0.0.1",
        port: 1,
        user: "nobody",
        database: "missing",
        migrationsDir: "migrations/base",
        pool: { min: 0, max: 1, acquireTimeoutMillis: 2_000 },
      },
    });
    project.write("migrations/base/1_registry.js", "// tenora:registry\nexport const up = () => {};\nexport const down = () => {};\n");

    assertFailed(project.tenora(["migrate"]));
  });
});

describe("drop:tenant", () => {
  it("refuses without --force before touching the config or the database", () => {
    const project = newProject();
    const result = assertFailed(project.tenora(["drop:tenant", "acme"]));
    assert.match(result.stderr, /Re-run with --force/);
  });
});

describe("CommonJS projects", () => {
  for (const [label, type] of [
    ['with "type": "commonjs"', "commonjs"],
    ["with no type field", null],
  ]) {
    it(`runs the whole base flow in a project ${label}`, () => {
      const project = sqliteProject({ type });

      assertOk(project.tenora(["migrate", "--create-base"]));
      assert.match(assertOk(project.tenora(["migrate"])).stdout, /create_tenant_registry/);
      assertOk(project.tenora(["make:migration", "create_products"]));
      assert.match(assertOk(project.tenora(["migrate"])).stdout, /create_products/);
      assert.match(assertOk(project.tenora(["rollback"])).stdout, /create_products/);
    });
  }
});
