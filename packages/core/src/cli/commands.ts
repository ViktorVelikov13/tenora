import type { Command } from "commander";
import { checkTenantSchemaDump } from "../factory/schemaFile";
import { createTenoraFactory } from "../knexFactory";
import type { CliConfig, TenantManager, TenantRecord } from "../types";
import { listTenantsFromRegistry } from "../tenantRegistry";
import { ensureRegistryMigrationIfNeeded, getTenantPassword, loadCliConfig } from "./config";
import { ensureBaseDatabase, makeKnexForDirs } from "./database";
import { createReporter, type Reporter } from "./reporter";
import {
  normalizeCreatedPath,
  resolveTemplateModuleType,
  writeMigrationTemplate,
  writeSeedTemplate,
} from "./templates";
import { runMigrations, runSeeds } from "./tracking";

type RunOptions = { config: string; createBase?: boolean };
type MigrateOptions = RunOptions & { step?: boolean };
type TemplateOptions = { config: string; esm?: boolean; cjs?: boolean };

const STEP_DESCRIPTION = "run each migration in its own batch, so rollback can undo them one at a time";

/** Builds a commander action whose output goes through a reporter. */
const report =
  <Args extends unknown[]>(command: string, run: (reporter: Reporter, ...args: Args) => void | Promise<void>) =>
  async (...args: Args) => {
    const reporter = createReporter(command);
    try {
      await run(reporter, ...args);
      reporter.finish();
    } catch (error) {
      reporter.fail(error);
    }
  };

const runMakeMigration = async (
  reporter: Reporter,
  scope: "base" | "tenants",
  name: string,
  opts: TemplateOptions
) => {
  const cfg = await loadCliConfig(opts.config);
  const dir = scope === "base" ? cfg.base.migrationsDir : cfg.tenant?.migrationsDir;
  if (!dir) {
    throw new Error(
      `Tenora: ${scope === "base" ? "base.migrationsDir" : "tenant.migrationsDir"} is required to create migrations.`
    );
  }
  const moduleType = resolveTemplateModuleType(opts);
  const client = makeKnexForDirs(cfg, dir);
  try {
    const created = await client.migrate.make(name);
    const file = normalizeCreatedPath(created);
    writeMigrationTemplate(file, moduleType, name);
    reporter.line(file);
  } finally {
    await client.destroy();
  }
};

const runMakeSeed = async (
  reporter: Reporter,
  scope: "base" | "tenants",
  name: string,
  opts: TemplateOptions
) => {
  const cfg = await loadCliConfig(opts.config);
  const dir = scope === "base" ? cfg.base.seedsDir : cfg.tenant?.seedsDir;
  if (!dir) {
    throw new Error(
      `Tenora: ${scope === "base" ? "base.seedsDir" : "tenant.seedsDir"} is required to create seeds.`
    );
  }
  const moduleType = resolveTemplateModuleType(opts);
  const client = makeKnexForDirs(cfg, undefined, dir);
  try {
    const created = await client.seed.make(name);
    const file = normalizeCreatedPath(created);
    writeSeedTemplate(file, moduleType);
    reporter.line(file);
  } finally {
    await client.destroy();
  }
};

const migrateBase = async (reporter: Reporter, opts: MigrateOptions) => {
  const cfg = await loadCliConfig(opts.config);
  if (opts.createBase) {
    await ensureBaseDatabase(cfg);
  }
  if (ensureRegistryMigrationIfNeeded(cfg)) return;
  const manager = createTenoraFactory(cfg);
  try {
    const base = manager.getBase();
    await reporter.target(
      "Base",
      "migrate",
      (steps) => runMigrations(base, opts.step ? "oneByOne" : "latest", steps),
      (files) => (files.length ? files.join("\n") : "Base up to date")
    );
  } finally {
    await manager.destroyAll();
  }
};

const rollbackBase = async (reporter: Reporter, opts: { config: string }) => {
  const cfg = await loadCliConfig(opts.config);
  const manager = createTenoraFactory(cfg);
  try {
    const base = manager.getBase();
    await reporter.target(
      "Base",
      "rollback",
      (steps) => runMigrations(base, "rollback", steps),
      (files) => (files.length ? files.join("\n") : "Nothing to rollback")
    );
  } finally {
    await manager.destroyAll();
  }
};

const addBaseCommands = (program: Command) => {
  program
    .command("migrate:base")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .option("--step", STEP_DESCRIPTION)
    .description("Run base database migrations")
    .action(report("migrate:base", migrateBase));

  program
    .command("migrate")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .option("--step", STEP_DESCRIPTION)
    .description("Run base database migrations (alias of migrate:base)")
    .action(report("migrate", migrateBase));

  program
    .command("rollback:base")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Rollback last base migration batch")
    .action(report("rollback:base", rollbackBase));

  program
    .command("rollback")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Rollback last base migration batch (alias of rollback:base)")
    .action(report("rollback", rollbackBase));
};

/** Goes through every tenant in the registry, one at a time, stopping at the first failure. */
const forEachTenant = async (
  reporter: Reporter,
  cfg: CliConfig,
  manager: TenantManager,
  work: (tenant: TenantRecord, tenantKnex: ReturnType<TenantManager["getTenant"]>) => Promise<void>
) => {
  const tenants = await listTenantsFromRegistry(manager.getBase(), cfg);
  reporter.expectTenants(tenants.length);
  for (const tenant of tenants) {
    const pwd = getTenantPassword(tenant, cfg.decryptPassword, cfg);
    const tenantKnex = manager.getTenant(tenant.id, pwd);
    await work(tenant, tenantKnex);
    await tenantKnex.destroy();
  }
};

const addTenantCommands = (program: Command) => {
  program
    .command("migrate:tenants")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .option("--step", STEP_DESCRIPTION)
    .description("Run tenant database migrations for all tenants")
    .action(
      report("migrate:tenants", async (reporter, opts: MigrateOptions) => {
        const cfg = await loadCliConfig(opts.config);
        if (opts.createBase) {
          await ensureBaseDatabase(cfg);
        }
        if (ensureRegistryMigrationIfNeeded(cfg)) return;
        const manager = createTenoraFactory(cfg);
        try {
          await forEachTenant(reporter, cfg, manager, (tenant, tenantKnex) =>
            reporter.target(
              tenant.id,
              "migrate",
              (steps) => runMigrations(tenantKnex, opts.step ? "oneByOne" : "latest", steps),
              (files) => `Tenant ${tenant.id}: ${files.length ? files.join(", ") : "up to date"}`
            )
          );
        } finally {
          await manager.destroyAll();
        }
      })
    );

  program
    .command("rollback:tenants")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Rollback last migration batch for all tenants")
    .action(
      report("rollback:tenants", async (reporter, opts: { config: string }) => {
        const cfg = await loadCliConfig(opts.config);
        const manager = createTenoraFactory(cfg);
        try {
          await forEachTenant(reporter, cfg, manager, (tenant, tenantKnex) =>
            reporter.target(
              tenant.id,
              "rollback",
              (steps) => runMigrations(tenantKnex, "rollback", steps),
              (files) => `Tenant ${tenant.id}: ${files.length ? files.join(", ") : "Nothing to rollback"}`
            )
          );
        } finally {
          await manager.destroyAll();
        }
      })
    );

  program
    .command("schema:dump:tenants")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--prune", "delete the migration files the dump now contains")
    .option("--check", "only check that the dump contains every migration file, without a database")
    .description("Write the tenant database structure to a file that new tenants load instead of running every migration")
    .action(
      report("schema:dump:tenants", async (reporter, opts: { config: string; prune?: boolean; check?: boolean }) => {
        const cfg = await loadCliConfig(opts.config);
        if (opts.check) {
          const { file, exists, missing } = await checkTenantSchemaDump(cfg);
          if (!exists) {
            reporter.problem(`Tenora: there is no schema dump at ${file}. Run tenora schema:dump:tenants.`);
          } else if (missing.length) {
            reporter.problem(
              `Tenora: the schema dump ${file} is out of date. It does not contain: ${missing.join(", ")}. Run tenora schema:dump:tenants.`
            );
          } else {
            reporter.line(`Schema dump ${file} is up to date`);
          }
          return;
        }
        const manager = createTenoraFactory(cfg);
        try {
          const { file, migrations, pruned } = await reporter.task("Building the schema dump", () =>
            manager.dumpTenantSchema({ prune: opts.prune })
          );
          reporter.line(`Schema dump ${file}: ${migrations.length} migrations`);
          for (const prunedFile of pruned) reporter.line(`Pruned ${prunedFile}`);
        } finally {
          await manager.destroyAll();
        }
      })
    );

  program
    .command("drop:tenant <id>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--force", "confirm that the tenant's data should be permanently deleted")
    .option("--allow-unregistered", "also drop a tenant that is missing from the registry")
    .description("Permanently delete a tenant database, its user and its registry entry")
    .action(
      report(
        "drop:tenant",
        async (reporter, id: string, opts: { config: string; force?: boolean; allowUnregistered?: boolean }) => {
          if (!opts.force) {
            reporter.problem(`Tenora: this permanently deletes tenant "${id}". Re-run with --force to confirm.`);
            return;
          }
          const cfg = await loadCliConfig(opts.config);
          const manager = createTenoraFactory(cfg);
          try {
            await reporter.task(`Dropping tenant ${id}`, () =>
              manager.dropTenantDb(id, { allowUnregistered: opts.allowUnregistered })
            );
            reporter.line(`Tenant ${id}: dropped`);
          } finally {
            await manager.destroyAll();
          }
        }
      )
    );
};

const addTemplateCommands = (program: Command) => {
  program
    .command("make:migration <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a base migration file (alias of make:migration:base)")
    .action(
      report("make:migration", (reporter, name: string, opts: TemplateOptions) =>
        runMakeMigration(reporter, "base", name, opts)
      )
    );

  program
    .command("make:migration:base <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a base migration file")
    .action(
      report("make:migration:base", (reporter, name: string, opts: TemplateOptions) =>
        runMakeMigration(reporter, "base", name, opts)
      )
    );

  program
    .command("make:migration:tenants <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a tenant migration file")
    .action(
      report("make:migration:tenants", (reporter, name: string, opts: TemplateOptions) =>
        runMakeMigration(reporter, "tenants", name, opts)
      )
    );

  program
    .command("make:seed <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a base seed file (alias of make:seed:base)")
    .action(
      report("make:seed", (reporter, name: string, opts: TemplateOptions) =>
        runMakeSeed(reporter, "base", name, opts)
      )
    );

  program
    .command("make:seed:base <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a base seed file")
    .action(
      report("make:seed:base", (reporter, name: string, opts: TemplateOptions) =>
        runMakeSeed(reporter, "base", name, opts)
      )
    );

  program
    .command("make:seed:tenants <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a tenant seed file")
    .action(
      report("make:seed:tenants", (reporter, name: string, opts: TemplateOptions) =>
        runMakeSeed(reporter, "tenants", name, opts)
      )
    );
};

const seedBase = async (reporter: Reporter, opts: RunOptions) => {
  const cfg = await loadCliConfig(opts.config);
  if (opts.createBase) {
    await ensureBaseDatabase(cfg);
  }
  const manager = createTenoraFactory(cfg);
  try {
    const base = manager.getBase();
    await reporter.target(
      "Base",
      "seed",
      (steps) => runSeeds(base, steps),
      (files) => (files.length ? files.join("\n") : "No seeds executed")
    );
  } finally {
    await manager.destroyAll();
  }
};

const addSeedRunCommands = (program: Command) => {
  program
    .command("seed:run:base")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .description("Run base database seeds")
    .action(report("seed:run:base", seedBase));

  program
    .command("seed:run")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .description("Run base database seeds (alias of seed:run:base)")
    .action(report("seed:run", seedBase));

  program
    .command("seed:run:tenants")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .description("Run tenant database seeds for all tenants")
    .action(
      report("seed:run:tenants", async (reporter, opts: RunOptions) => {
        const cfg = await loadCliConfig(opts.config);
        if (opts.createBase) {
          await ensureBaseDatabase(cfg);
        }
        if (ensureRegistryMigrationIfNeeded(cfg)) return;
        const manager = createTenoraFactory(cfg);
        try {
          await forEachTenant(reporter, cfg, manager, (tenant, tenantKnex) =>
            reporter.target(
              tenant.id,
              "seed",
              (steps) => runSeeds(tenantKnex, steps),
              (files) => `Tenant ${tenant.id}: ${files.length ? files.join(", ") : "No seeds executed"}`
            )
          );
        } finally {
          await manager.destroyAll();
        }
      })
    );
};

export const registerCliCommands = (program: Command) => {
  addBaseCommands(program);
  addTenantCommands(program);
  addTemplateCommands(program);
  addSeedRunCommands(program);

  program
    .command("list")
    .description("List available commands")
    .action(() => program.outputHelp());
};
