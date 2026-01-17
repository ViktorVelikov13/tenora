#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs";
import knex from "knex";
import path from "path";
import { pathToFileURL } from "url";
import { createTenoraFactory } from "./knexFactory.js";
import { ensureRegistryMigration, listTenantsFromRegistry } from "./tenantRegistry.js";
import type { CliConfig, TenantRecord } from "./types";

const program = new Command();

const ensureRegistryMigrationIfNeeded = (cfg: CliConfig): boolean => {
  const result = ensureRegistryMigration(cfg);
  if (result.created) {
    console.log(
      `Tenora: created tenant registry migration at ${result.filePath}. Review it (rename if desired), then run 'tenora migrate' again.`
    );
    return true;
  }
  return false;
};

const findNearestPackageJson = (startDir: string): string | undefined => {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

const detectModuleType = (): "esm" | "cjs" => {
  const pkgPath = findNearestPackageJson(process.cwd());
  if (!pkgPath) return "cjs";
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const json = JSON.parse(raw);
    return json.type === "module" ? "esm" : "cjs";
  } catch {
    return "cjs";
  }
};

const resolveTemplateModuleType = (opts: { esm?: boolean; cjs?: boolean }): "esm" | "cjs" => {
  if (opts.esm && opts.cjs) {
    throw new Error("Tenora: choose only one of --esm or --cjs.");
  }
  if (opts.esm) return "esm";
  if (opts.cjs) return "cjs";
  return detectModuleType();
};

const normalizeCreatedPath = (created: string | string[]): string =>
  Array.isArray(created) ? created[0] : created;

const writeMigrationTemplate = (filePath: string, moduleType: "esm" | "cjs") => {
  const body =
    moduleType === "esm"
      ? `export const up = (knex) => {\n  // TODO\n};\n\nexport const down = (knex) => {\n  // TODO\n};\n`
      : `exports.up = (knex) => {\n  // TODO\n};\n\nexports.down = (knex) => {\n  // TODO\n};\n`;
  fs.writeFileSync(filePath, body);
};

const writeSeedTemplate = (filePath: string, moduleType: "esm" | "cjs") => {
  const body =
    moduleType === "esm"
      ? `export const seed = async (knex) => {\n  // TODO\n};\n`
      : `exports.seed = async (knex) => {\n  // TODO\n};\n`;
  fs.writeFileSync(filePath, body);
};

const makeKnexForDirs = (cfg: CliConfig, migrationsDir?: string, seedsDir?: string) =>
  knex({
    client: "pg",
    useNullAsDefault: true,
    connection: {
      host: cfg.base.host,
      port: cfg.base.port,
      user: cfg.base.user,
      password: cfg.base.password,
      database: cfg.base.database,
      ssl: cfg.base.ssl ?? false,
    },
    migrations: migrationsDir ? { directory: migrationsDir } : undefined,
    seeds: seedsDir ? { directory: seedsDir } : undefined,
  });

const ensureBaseDatabase = async (cfg: CliConfig) => {
  const { base } = cfg;
  const admin = knex({
    client: "pg",
    useNullAsDefault: true,
    connection: {
      host: base.host,
      port: base.port,
      user: base.user,
      password: base.password,
      database: "postgres",
      ssl: base.ssl ?? false,
    },
  });

  try {
    const result = await admin.raw(`SELECT 1 FROM pg_database WHERE datname = ?`, [base.database]);
    if (result?.rows?.length) return;

    const safeName = base.database.replace(/"/g, '""');
    await admin.raw(`CREATE DATABASE "${safeName}"`);
    console.log(`Tenora: created base database "${base.database}"`);
  } finally {
    await admin.destroy();
  }
};

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
    .option("--create-base", "create base database if missing")
    .description("Run base database migrations")
    .action(async (opts) => {
      const cfg = await loadConfig(opts.config);
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

  // Short alias: `tenora migrate` == migrate base
  program
    .command("migrate")
    .option("-c, --config <path>", "config file", "tenora.config.js")
    .option("--create-base", "create base database if missing")
    .description("Run base database migrations (alias of migrate:base)")
    .action(async (opts) => {
      const cfg = await loadConfig(opts.config);
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
    .option("--create-base", "create base database if missing")
    .description("Run tenant database migrations for all tenants")
    .action(async (opts) => {
      const cfg = await loadConfig(opts.config);
      if (opts.createBase) {
        await ensureBaseDatabase(cfg);
      }
      if (ensureRegistryMigrationIfNeeded(cfg)) return;
      const manager = createTenoraFactory(cfg);
      try {
        const tenants = await listTenantsFromRegistry(manager.getBase(), cfg);
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
        const tenants = await listTenantsFromRegistry(manager.getBase(), cfg);
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
  .command("make:migration:base <name>")
  .option("-c, --config <path>", "config file", "tenora.config.js")
  .option("--esm", "force ESM template output")
  .option("--cjs", "force CommonJS template output")
  .description("Create a base migration file")
  .action(async (name, opts) => {
    const cfg = await loadConfig(opts.config);
    if (!cfg.base.migrationsDir) {
      throw new Error("Tenora: base.migrationsDir is required to create base migrations.");
    }
    const moduleType = resolveTemplateModuleType(opts);
    const client = makeKnexForDirs(cfg, cfg.base.migrationsDir);
    try {
      const created = await client.migrate.make(name);
      const file = normalizeCreatedPath(created);
        writeMigrationTemplate(file, moduleType);
        console.log(file);
      } finally {
        await client.destroy();
      }
    });

program
  .command("make:migration:tenants <name>")
  .option("-c, --config <path>", "config file", "tenora.config.js")
  .option("--esm", "force ESM template output")
  .option("--cjs", "force CommonJS template output")
  .description("Create a tenant migration file")
  .action(async (name, opts) => {
    const cfg = await loadConfig(opts.config);
    if (!cfg.tenant?.migrationsDir) {
      throw new Error("Tenora: tenant.migrationsDir is required to create tenant migrations.");
    }
    const moduleType = resolveTemplateModuleType(opts);
    const client = makeKnexForDirs(cfg, cfg.tenant.migrationsDir);
    try {
      const created = await client.migrate.make(name);
      const file = normalizeCreatedPath(created);
        writeMigrationTemplate(file, moduleType);
        console.log(file);
      } finally {
        await client.destroy();
      }
    });

program
  .command("make:seed:base <name>")
  .option("-c, --config <path>", "config file", "tenora.config.js")
  .option("--esm", "force ESM template output")
  .option("--cjs", "force CommonJS template output")
  .description("Create a base seed file")
  .action(async (name, opts) => {
    const cfg = await loadConfig(opts.config);
    if (!cfg.base.seedsDir) {
      throw new Error("Tenora: base.seedsDir is required to create base seeds.");
    }
    const moduleType = resolveTemplateModuleType(opts);
    const client = makeKnexForDirs(cfg, undefined, cfg.base.seedsDir);
    try {
      const created = await client.seed.make(name);
      const file = normalizeCreatedPath(created);
        writeSeedTemplate(file, moduleType);
        console.log(file);
      } finally {
        await client.destroy();
      }
    });

program
  .command("make:seed:tenants <name>")
  .option("-c, --config <path>", "config file", "tenora.config.js")
  .option("--esm", "force ESM template output")
  .option("--cjs", "force CommonJS template output")
  .description("Create a tenant seed file")
  .action(async (name, opts) => {
    const cfg = await loadConfig(opts.config);
    if (!cfg.tenant?.seedsDir) {
      throw new Error("Tenora: tenant.seedsDir is required to create tenant seeds.");
    }
    const moduleType = resolveTemplateModuleType(opts);
    const client = makeKnexForDirs(cfg, undefined, cfg.tenant.seedsDir);
    try {
      const created = await client.seed.make(name);
        const file = normalizeCreatedPath(created);
        writeSeedTemplate(file, moduleType);
        console.log(file);
      } finally {
        await client.destroy();
      }
    });

program
  .command("seed:run:base")
  .option("-c, --config <path>", "config file", "tenora.config.js")
  .option("--create-base", "create base database if missing")
  .description("Run base database seeds")
  .action(async (opts) => {
    const cfg = await loadConfig(opts.config);
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
  .action(async (opts) => {
    const cfg = await loadConfig(opts.config);
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
  .action(async (opts) => {
    const cfg = await loadConfig(opts.config);
    if (opts.createBase) {
      await ensureBaseDatabase(cfg);
    }
    if (ensureRegistryMigrationIfNeeded(cfg)) return;
      const manager = createTenoraFactory(cfg);
      try {
        const tenants = await listTenantsFromRegistry(manager.getBase(), cfg);
        for (const tenant of tenants) {
          const pwd = getTenantPassword(tenant, cfg.decryptPassword);
          const knex = manager.getTenant(tenant.id, pwd);
          const result = await knex.seed.run();
          const files = Array.isArray(result) ? result[0] : [];
          console.log(`Tenant ${tenant.id}: ${files.length ? files.join(", ") : "No seeds executed"}`);
          await knex.destroy();
        }
    } finally {
      await manager.destroyAll();
    }
  });

program
  .command("list")
  .description("List available commands")
  .action(() => program.outputHelp());

program.parse(process.argv);
