import fs from "fs";
import knex from "knex";
import path from "path";
import type { CliConfig } from "../types";

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

export const makeKnexForDirs = (cfg: CliConfig, migrationsDir?: string, seedsDir?: string) =>
  knex({
    client: resolveClient(cfg.base.client),
    useNullAsDefault: true,
    connection: buildBaseConnection(cfg),
    migrations: migrationsDir ? { directory: migrationsDir } : undefined,
    seeds: seedsDir ? { directory: seedsDir } : undefined,
  });

export const ensureBaseDatabase = async (cfg: CliConfig) => {
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
