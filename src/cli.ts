#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs";
import knex from "knex";
import path from "path";
import { createTenoraFactory } from "./knexFactory";
import { loadConfigModuleAsync, resolveConfigPath, unwrapConfig } from "./configLoader";
import { ensureRegistryMigration, listTenantsFromRegistry, resolveDecrypt } from "./tenantRegistry";
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

const resolveClient = (value?: string): string => value ?? "pg";

const isPostgresClient = (client: string): boolean =>
  client === "pg" || client === "postgres" || client === "postgresql";

const isMysqlClient = (client: string): boolean =>
  client === "mysql" || client === "mysql2" || client === "mariadb";

const isSqliteClient = (client: string): boolean =>
  client === "sqlite3" || client === "better-sqlite3" || client === "sqlite";

const isMssqlClient = (client: string): boolean =>
  client === "mssql" || client === "sqlserver";

const normalizePassword = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return String(value);
};

const escapePgIdent = (value: string) => value.replace(/"/g, "\"\"");
const escapeMysqlIdent = (value: string) => value.replace(/`/g, "``");
const escapeMssqlIdent = (value: string) => value.replace(/]/g, "]]");
const escapeSqlString = (value: string) => value.replace(/'/g, "''");

const resolveBaseDatabaseName = (cfg: CliConfig): string => {
  const client = resolveClient(cfg.base.client);
  if (cfg.base.connection) {
    const conn = cfg.base.connection as unknown as Record<string, unknown>;
    if (isSqliteClient(client)) {
      const filename = (conn.filename as string | undefined) ?? cfg.base.database;
      if (!filename) {
        throw new Error("Tenora: base.database or base.connection.filename is required for SQLite.");
      }
      return filename;
    }
    const dbName = (conn.database as string | undefined) ?? cfg.base.database;
    if (!dbName) throw new Error("Tenora: base.database is required.");
    return dbName;
  }

  if (!cfg.base.database) {
    throw new Error("Tenora: base.database is required.");
  }
  return cfg.base.database;
};

const applyConnectionDefaults = (cfg: CliConfig, conn: Record<string, unknown>) => {
  const client = resolveClient(cfg.base.client);
  if (conn.user === undefined && cfg.base.user !== undefined) conn.user = cfg.base.user;
  if (conn.port === undefined && cfg.base.port !== undefined) conn.port = cfg.base.port;
  if (isMssqlClient(client)) {
    if (conn.server === undefined && cfg.base.host !== undefined) conn.server = cfg.base.host;
  } else if (conn.host === undefined && cfg.base.host !== undefined) {
    conn.host = cfg.base.host;
  }
  if (conn.ssl === undefined && cfg.base.ssl !== undefined) conn.ssl = cfg.base.ssl;
  const normalized = normalizePassword(conn.password ?? cfg.base.password);
  if (normalized !== undefined) {
    conn.password = normalized;
  } else {
    delete conn.password;
  }
};

const buildBaseConnection = (cfg: CliConfig, databaseOverride?: string) => {
  const client = resolveClient(cfg.base.client);
  if (cfg.base.connection) {
    const conn = { ...(cfg.base.connection as unknown as Record<string, unknown>) };
    applyConnectionDefaults(cfg, conn);
    if (databaseOverride !== undefined) {
      if (isSqliteClient(client)) {
        conn.filename = databaseOverride;
        delete conn.database;
      } else {
        conn.database = databaseOverride;
      }
    } else if (isSqliteClient(client)) {
      if (conn.filename === undefined && cfg.base.database) conn.filename = cfg.base.database;
    } else if (conn.database === undefined && cfg.base.database) {
      conn.database = cfg.base.database;
    }
    return conn;
  }

  if (isSqliteClient(client)) {
    const filename = databaseOverride ?? cfg.base.database;
    if (!filename) {
      throw new Error("Tenora: base.database is required for SQLite.");
    }
    return { filename };
  }

  if (!cfg.base.host || !cfg.base.user || !cfg.base.database) {
    throw new Error("Tenora: base connection is incomplete. Provide base.connection or host/user/database.");
  }

  const conn: Record<string, unknown> = {
    ...(isMssqlClient(client) ? { server: cfg.base.host } : { host: cfg.base.host }),
    port: cfg.base.port,
    user: cfg.base.user,
    database: databaseOverride ?? cfg.base.database,
    ssl: cfg.base.ssl ?? false,
  };
  const basePassword = normalizePassword(cfg.base.password);
  if (basePassword !== undefined) conn.password = basePassword;
  return conn;
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
    client: resolveClient(cfg.base.client),
    useNullAsDefault: true,
    connection: buildBaseConnection(cfg),
    migrations: migrationsDir ? { directory: migrationsDir } : undefined,
    seeds: seedsDir ? { directory: seedsDir } : undefined,
  });

const ensureBaseDatabase = async (cfg: CliConfig) => {
  const client = resolveClient(cfg.base.client);
  const baseDb = resolveBaseDatabaseName(cfg);

  if (isSqliteClient(client)) {
    if (baseDb === ":memory:") return;
    fs.mkdirSync(path.dirname(baseDb), { recursive: true });
    if (!fs.existsSync(baseDb)) {
      fs.closeSync(fs.openSync(baseDb, "a"));
      console.log(`Tenora: created base database "${baseDb}"`);
    }
    return;
  }

  const adminDatabase =
    cfg.base.adminDatabase ??
    (isPostgresClient(client)
      ? "postgres"
      : isMysqlClient(client)
        ? "mysql"
        : isMssqlClient(client)
          ? "master"
          : baseDb);
  const admin = knex({
    client,
    useNullAsDefault: true,
    connection: buildBaseConnection(cfg, adminDatabase),
  });

  try {
    if (isPostgresClient(client)) {
      const result = await admin.raw(`SELECT 1 FROM pg_database WHERE datname = ?`, [baseDb]);
      if (result?.rows?.length) return;

      const safeName = escapePgIdent(baseDb);
      await admin.raw(`CREATE DATABASE "${safeName}"`);
    } else if (isMysqlClient(client)) {
      const result = await admin.raw(
        `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?`,
        [baseDb]
      );
      if (result?.[0]?.length) return;

      const safeName = escapeMysqlIdent(baseDb);
      await admin.raw(`CREATE DATABASE \`${safeName}\``);
    } else if (isMssqlClient(client)) {
      const result = await admin.raw(`SELECT name FROM sys.databases WHERE name = ?`, [baseDb]);
      if (result?.[0]?.length) return;

      const safeName = escapeMssqlIdent(baseDb);
      await admin.raw(`CREATE DATABASE [${safeName}]`);
    } else {
      throw new Error(
        `Tenora: --create-base is only supported for Postgres, MySQL/MariaDB, SQLite, and SQL Server clients (got "${client}").`
      );
    }
    console.log(`Tenora: created base database "${baseDb}"`);
  } finally {
    await admin.destroy();
  }
};

const loadConfig = async (configPath: string): Promise<CliConfig> => {
  const isDefault = configPath === "tenora.config.js";
  let fullPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);
  if (isDefault && !fs.existsSync(fullPath)) {
    fullPath = resolveConfigPath();
  }
  const module = await loadConfigModuleAsync(fullPath);
  const cfg = unwrapConfig(module);
  if (!cfg) {
    throw new Error(`No config exported from ${fullPath}`);
  }
  return cfg as CliConfig;
};

const getTenantPassword = (
  tenant: TenantRecord,
  decryptPassword?: (encrypted: string) => string,
  cfg?: CliConfig
) => {
  if (tenant.password) return tenant.password;
  if (tenant.encryptedPassword) {
    const resolver = decryptPassword ?? (cfg ? resolveDecrypt(cfg) : undefined);
    if (resolver) return resolver(tenant.encryptedPassword);
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
          const pwd = getTenantPassword(tenant, cfg.decryptPassword, cfg);
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
          const pwd = getTenantPassword(tenant, cfg.decryptPassword, cfg);
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
        const pwd = getTenantPassword(tenant, cfg.decryptPassword, cfg);
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
