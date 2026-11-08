import type { Command } from "commander";
import { checkTenantSchemaDump } from "../factory/schemaFile";
import { createTenoraFactory } from "../tenoraFactory";
import { listTenantsFromRegistry } from "../tenantRegistry";
import { ensureRegistryMigrationIfNeeded, getTenantPassword, loadCliConfig } from "./config";
import { ensureBaseDatabase } from "./database";
import {
  newMigrationPath,
  newSeedPath,
  resolveTemplateModuleType,
  writeMigrationTemplate,
  writeSeedTemplate,
} from "./templates";

const runMakeMigration = async (
  scope: "base" | "tenants",
  name: string,
  opts: { config: string; esm?: boolean; cjs?: boolean }
) => {
  const cfg = await loadCliConfig(opts.config);
  const dir = scope === "base" ? cfg.base.migrationsDir : cfg.tenant?.migrationsDir;
  if (!dir) {
    throw new Error(
      `Tenora: ${scope === "base" ? "base.migrationsDir" : "tenant.migrationsDir"} is required to create migrations.`
    );
  }
  const moduleType = resolveTemplateModuleType(opts);
  const file = newMigrationPath(dir, name);
  writeMigrationTemplate(file, moduleType, name);
  console.log(file);
};

const runMakeSeed = async (
  scope: "base" | "tenants",
  name: string,
  opts: { config: string; esm?: boolean; cjs?: boolean }
) => {
  const cfg = await loadCliConfig(opts.config);
  const dir = scope === "base" ? cfg.base.seedsDir : cfg.tenant?.seedsDir;
  if (!dir) {
    throw new Error(
      `Tenora: ${scope === "base" ? "base.seedsDir" : "tenant.seedsDir"} is required to create seeds.`
    );
  }
  const moduleType = resolveTemplateModuleType(opts);
  const file = newSeedPath(dir, name);
  writeSeedTemplate(file, moduleType);
  console.log(file);
};

const addBaseCommands = (program: Command) => {
  program
    .command("migrate:base")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .description("Run base database migrations")
    .action(async (opts: { config: string; createBase?: boolean }) => {
      const cfg = await loadCliConfig(opts.config);
      if (opts.createBase) {
        await ensureBaseDatabase(cfg);
      }
      if (ensureRegistryMigrationIfNeeded(cfg)) return;
      const manager = createTenoraFactory(cfg);
      try {
        const { migrations } = await manager.baseMigrator().latest();
        console.log(migrations.length ? migrations.join("\n") : "Base up to date");
      } finally {
        await manager.destroyAll();
      }
    });

  program
    .command("migrate")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .description("Run base database migrations (alias of migrate:base)")
    .action(async (opts: { config: string; createBase?: boolean }) => {
      const cfg = await loadCliConfig(opts.config);
      if (opts.createBase) {
        await ensureBaseDatabase(cfg);
      }
      if (ensureRegistryMigrationIfNeeded(cfg)) return;
      const manager = createTenoraFactory(cfg);
      try {
        const { migrations } = await manager.baseMigrator().latest();
        console.log(migrations.length ? migrations.join("\n") : "Base up to date");
      } finally {
        await manager.destroyAll();
      }
    });

  program
    .command("rollback:base")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Rollback last base migration batch")
    .action(async (opts: { config: string }) => {
      const cfg = await loadCliConfig(opts.config);
      const manager = createTenoraFactory(cfg);
      try {
        const { migrations } = await manager.baseMigrator().rollback();
        console.log(migrations.length ? migrations.join("\n") : "Nothing to rollback");
      } finally {
        await manager.destroyAll();
      }
    });

  program
    .command("rollback")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Rollback last base migration batch (alias of rollback:base)")
    .action(async (opts: { config: string }) => {
      const cfg = await loadCliConfig(opts.config);
      const manager = createTenoraFactory(cfg);
      try {
        const { migrations } = await manager.baseMigrator().rollback();
        console.log(migrations.length ? migrations.join("\n") : "Nothing to rollback");
      } finally {
        await manager.destroyAll();
      }
    });
};

const addTenantCommands = (program: Command) => {
  program
    .command("migrate:tenants")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .description("Run tenant database migrations for all tenants")
    .action(async (opts: { config: string; createBase?: boolean }) => {
      const cfg = await loadCliConfig(opts.config);
      if (opts.createBase) {
        await ensureBaseDatabase(cfg);
      }
      if (ensureRegistryMigrationIfNeeded(cfg)) return;
      const manager = createTenoraFactory(cfg);
      try {
        const tenants = await listTenantsFromRegistry(manager.getBase(), cfg);
        for (const tenant of tenants) {
          const pwd = getTenantPassword(tenant, cfg.decryptPassword, cfg);
          const { migrations } = await manager.tenantMigrator(tenant.id, pwd).latest();
          console.log(`Tenant ${tenant.id}: ${migrations.length ? migrations.join(", ") : "up to date"}`);
          await manager.destroyTenant(tenant.id);
        }
      } finally {
        await manager.destroyAll();
      }
    });

  program
    .command("rollback:tenants")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Rollback last migration batch for all tenants")
    .action(async (opts: { config: string }) => {
      const cfg = await loadCliConfig(opts.config);
      const manager = createTenoraFactory(cfg);
      try {
        const tenants = await listTenantsFromRegistry(manager.getBase(), cfg);
        for (const tenant of tenants) {
          const pwd = getTenantPassword(tenant, cfg.decryptPassword, cfg);
          const { migrations } = await manager.tenantMigrator(tenant.id, pwd).rollback();
          console.log(`Tenant ${tenant.id}: ${migrations.length ? migrations.join(", ") : "Nothing to rollback"}`);
          await manager.destroyTenant(tenant.id);
        }
      } finally {
        await manager.destroyAll();
      }
    });

  program
    .command("schema:dump:tenants")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--prune", "delete the migration files the dump now contains")
    .option("--check", "only check that the dump contains every migration file, without a database")
    .description("Write the tenant database structure to a file that new tenants load instead of running every migration")
    .action(async (opts: { config: string; prune?: boolean; check?: boolean }) => {
      const cfg = await loadCliConfig(opts.config);
      if (opts.check) {
        const { file, exists, missing } = await checkTenantSchemaDump(cfg);
        if (!exists) {
          console.error(`Tenora: there is no schema dump at ${file}. Run tenora schema:dump:tenants.`);
          process.exitCode = 1;
        } else if (missing.length) {
          console.error(
            `Tenora: the schema dump ${file} is out of date. It does not contain: ${missing.join(", ")}. Run tenora schema:dump:tenants.`
          );
          process.exitCode = 1;
        } else {
          console.log(`Schema dump ${file} is up to date`);
        }
        return;
      }
      const manager = createTenoraFactory(cfg);
      try {
        const { file, migrations, pruned } = await manager.dumpTenantSchema({ prune: opts.prune });
        console.log(`Schema dump ${file}: ${migrations.length} migrations`);
        for (const prunedFile of pruned) console.log(`Pruned ${prunedFile}`);
      } finally {
        await manager.destroyAll();
      }
    });

  program
    .command("drop:tenant <id>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--force", "confirm that the tenant's data should be permanently deleted")
    .option("--allow-unregistered", "also drop a tenant that is missing from the registry")
    .description("Permanently delete a tenant database, its user and its registry entry")
    .action(async (id: string, opts: { config: string; force?: boolean; allowUnregistered?: boolean }) => {
      if (!opts.force) {
        console.error(`Tenora: this permanently deletes tenant "${id}". Re-run with --force to confirm.`);
        process.exitCode = 1;
        return;
      }
      const cfg = await loadCliConfig(opts.config);
      const manager = createTenoraFactory(cfg);
      try {
        await manager.dropTenantDb(id, { allowUnregistered: opts.allowUnregistered });
        console.log(`Tenant ${id}: dropped`);
      } finally {
        await manager.destroyAll();
      }
    });
};

const addTemplateCommands = (program: Command) => {
  program
    .command("make:migration <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a base migration file (alias of make:migration:base)")
    .action((name: string, opts: { config: string; esm?: boolean; cjs?: boolean }) =>
      runMakeMigration("base", name, opts)
    );

  program
    .command("make:migration:base <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a base migration file")
    .action((name: string, opts: { config: string; esm?: boolean; cjs?: boolean }) =>
      runMakeMigration("base", name, opts)
    );

  program
    .command("make:migration:tenants <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a tenant migration file")
    .action((name: string, opts: { config: string; esm?: boolean; cjs?: boolean }) =>
      runMakeMigration("tenants", name, opts)
    );

  program
    .command("make:seed <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a base seed file (alias of make:seed:base)")
    .action((name: string, opts: { config: string; esm?: boolean; cjs?: boolean }) =>
      runMakeSeed("base", name, opts)
    );

  program
    .command("make:seed:base <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a base seed file")
    .action((name: string, opts: { config: string; esm?: boolean; cjs?: boolean }) =>
      runMakeSeed("base", name, opts)
    );

  program
    .command("make:seed:tenants <name>")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--esm", "force ESM template output")
    .option("--cjs", "force CommonJS template output")
    .description("Create a tenant seed file")
    .action((name: string, opts: { config: string; esm?: boolean; cjs?: boolean }) =>
      runMakeSeed("tenants", name, opts)
    );
};

const addSeedRunCommands = (program: Command) => {
  program
    .command("seed:run:base")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .description("Run base database seeds")
    .action(async (opts: { config: string; createBase?: boolean }) => {
      const cfg = await loadCliConfig(opts.config);
      if (opts.createBase) {
        await ensureBaseDatabase(cfg);
      }
      const manager = createTenoraFactory(cfg);
      try {
        const { seeds } = await manager.baseSeeder().run();
        console.log(seeds.length ? seeds.join("\n") : "No seeds executed");
      } finally {
        await manager.destroyAll();
      }
    });

  program
    .command("seed:run")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .description("Run base database seeds (alias of seed:run:base)")
    .action(async (opts: { config: string; createBase?: boolean }) => {
      const cfg = await loadCliConfig(opts.config);
      if (opts.createBase) {
        await ensureBaseDatabase(cfg);
      }
      const manager = createTenoraFactory(cfg);
      try {
        const { seeds } = await manager.baseSeeder().run();
        console.log(seeds.length ? seeds.join("\n") : "No seeds executed");
      } finally {
        await manager.destroyAll();
      }
    });

  program
    .command("seed:run:tenants")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .description("Run tenant database seeds for all tenants")
    .action(async (opts: { config: string; createBase?: boolean }) => {
      const cfg = await loadCliConfig(opts.config);
      if (opts.createBase) {
        await ensureBaseDatabase(cfg);
      }
      if (ensureRegistryMigrationIfNeeded(cfg)) return;
      const manager = createTenoraFactory(cfg);
      try {
        const tenants = await listTenantsFromRegistry(manager.getBase(), cfg);
        for (const tenant of tenants) {
          const pwd = getTenantPassword(tenant, cfg.decryptPassword, cfg);
          const { seeds } = await manager.tenantSeeder(tenant.id, pwd).run();
          console.log(`Tenant ${tenant.id}: ${seeds.length ? seeds.join(", ") : "No seeds executed"}`);
          await manager.destroyTenant(tenant.id);
        }
      } finally {
        await manager.destroyAll();
      }
    });
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
