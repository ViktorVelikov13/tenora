#!/usr/bin/env node
import { Command } from "commander";
import path from "path";
import { pathToFileURL } from "url";
import { createTenoraFactory } from "./knexFactory";
import { CliConfig, TenantRecord } from "./types";

const program = new Command();

const loadConfig = async (configPath: string): Promise<CliConfig> => {
  const fullPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);
  const module = await import(pathToFileURL(fullPath).href);
  const cfg = module.default ?? module.config ?? module;
  if (!cfg) {
    throw new Error(`No config exported from ${fullPath}`);
  }
  return cfg as CliConfig;
};

const getTenantPassword = (tenant: TenantRecord, decryptPassword?: (encrypted: string) => string) => {
  if (tenant.password) return tenant.password;
  if (tenant.encryptedPassword && decryptPassword) {
    return decryptPassword(tenant.encryptedPassword);
  }
  return undefined;
};

const addBaseCommands = () => {
  program
    .command("migrate:base")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Run base database migrations")
    .action(async (opts) => {
      const cfg = await loadConfig(opts.config);
      const manager = createTenoraFactory(cfg);
      try {
        const base = manager.getBase();
        const [, files] = await base.migrate.latest();
        console.log(files.length ? files.join("\n") : "Base up to date");
      } finally {
        await manager.destroyAll();
      }
    });

  // Short alias: `tenora migrate` == migrate base
  program
    .command("migrate")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Run base database migrations (alias of migrate:base)")
    .action(async (opts) => {
      const cfg = await loadConfig(opts.config);
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
    .action(async (opts) => {
      const cfg = await loadConfig(opts.config);
      const manager = createTenoraFactory(cfg);
      try {
        const base = manager.getBase();
        const [, files] = await base.migrate.rollback();
        console.log(files.length ? files.join("\n") : "Nothing to rollback");
      } finally {
        await manager.destroyAll();
      }
    });

  // Short alias: `tenora rollback` == rollback base
  program
    .command("rollback")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Rollback last base migration batch (alias of rollback:base)")
    .action(async (opts) => {
      const cfg = await loadConfig(opts.config);
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

const addTenantCommands = () => {
  program
    .command("migrate:tenants")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Run tenant database migrations for all tenants")
    .action(async (opts) => {
      const cfg = await loadConfig(opts.config);
      const manager = createTenoraFactory(cfg);
      try {
        const tenants = await cfg.listTenants();
        for (const tenant of tenants) {
          const pwd = getTenantPassword(tenant, cfg.decryptPassword);
          const knex = manager.getTenant(tenant.id, pwd);
          const [, files] = await knex.migrate.latest();
          console.log(`Tenant ${tenant.id}: ${files.length ? files.join(", ") : "up to date"}`);
          await knex.destroy();
        }
      } finally {
        await manager.destroyAll();
      }
    });

  program
    .command("rollback:tenants")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .description("Rollback last migration batch for all tenants")
    .action(async (opts) => {
      const cfg = await loadConfig(opts.config);
      const manager = createTenoraFactory(cfg);
      try {
        const tenants = await cfg.listTenants();
        for (const tenant of tenants) {
          const pwd = getTenantPassword(tenant, cfg.decryptPassword);
          const knex = manager.getTenant(tenant.id, pwd);
          const [, files] = await knex.migrate.rollback();
          console.log(`Tenant ${tenant.id}: ${files.length ? files.join(", ") : "Nothing to rollback"}`);
          await knex.destroy();
        }
      } finally {
        await manager.destroyAll();
      }
    });
};

addBaseCommands();
addTenantCommands();

program
  .command("list")
  .description("List available commands")
  .action(() => program.outputHelp());

program.parse(process.argv);
