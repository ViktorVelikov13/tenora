import type { Command } from "commander";
import { createTenoraFactory } from "../knexFactory";
import type { CliConfig } from "../types";
import { listTenantsFromRegistry } from "../tenantRegistry";
import { ensureRegistryMigrationIfNeeded, getTenantPassword, loadCliConfig } from "./config";
import { ensureBaseDatabase, makeKnexForDirs } from "./database";
import {
  normalizeCreatedPath,
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
  const client = makeKnexForDirs(cfg, dir);
  try {
    const created = await client.migrate.make(name);
    const file = normalizeCreatedPath(created);
    writeMigrationTemplate(file, moduleType, name);
    console.log(file);
  } finally {
    await client.destroy();
  }
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
  const client = makeKnexForDirs(cfg, undefined, dir);
  try {
    const created = await client.seed.make(name);
    const file = normalizeCreatedPath(created);
    writeSeedTemplate(file, moduleType);
    console.log(file);
  } finally {
    await client.destroy();
  }
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
        const base = manager.getBase();
        const [, files] = await base.migrate.latest();
        console.log(files.length ? files.join("\n") : "Base up to date");
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
        const base = manager.getBase();
        const [, files] = await base.migrate.latest();
        console.log(files.length ? files.join("\n") : "Base up to date");
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
        const base = manager.getBase();
        const [, files] = await base.migrate.rollback();
        console.log(files.length ? files.join("\n") : "Nothing to rollback");
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
        const base = manager.getBase();
        const [, files] = await base.migrate.rollback();
        console.log(files.length ? files.join("\n") : "Nothing to rollback");
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
          const tenantKnex = manager.getTenant(tenant.id, pwd);
          const [, files] = await tenantKnex.migrate.latest();
          console.log(`Tenant ${tenant.id}: ${files.length ? files.join(", ") : "up to date"}`);
          await tenantKnex.destroy();
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
          const tenantKnex = manager.getTenant(tenant.id, pwd);
          const [, files] = await tenantKnex.migrate.rollback();
          console.log(`Tenant ${tenant.id}: ${files.length ? files.join(", ") : "Nothing to rollback"}`);
          await tenantKnex.destroy();
        }
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
        const base = manager.getBase();
        const result = await base.seed.run();
        const files = Array.isArray(result) ? result[0] : [];
        console.log(files.length ? files.join("\n") : "No seeds executed");
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
        const base = manager.getBase();
        const result = await base.seed.run();
        const files = Array.isArray(result) ? result[0] : [];
        console.log(files.length ? files.join("\n") : "No seeds executed");
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
          const tenantKnex = manager.getTenant(tenant.id, pwd);
          const result = await tenantKnex.seed.run();
          const files = Array.isArray(result) ? result[0] : [];
          console.log(`Tenant ${tenant.id}: ${files.length ? files.join(", ") : "No seeds executed"}`);
          await tenantKnex.destroy();
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
