import { type Connection, createConnection, type PoolOptions } from "@tenora/orm";
import type { BaseConnectionConfig } from "../types";
import {
  isMssqlClient,
  isMysqlClient,
  isPostgresClient,
  isSqliteClient,
  normalizePassword,
  resolveClient,
} from "./shared";

export const resolveBaseDatabaseName = (base: BaseConnectionConfig): string => {
  if (base.connection) {
    const conn = base.connection;
    if (isSqliteClient(resolveClient(base.client))) {
      const filename = (conn.filename as string | undefined) ?? base.database;
      if (!filename) {
        throw new Error("Tenora: base.database or base.connection.filename is required for SQLite.");
      }
      return filename;
    }
    const dbName = (conn.database as string | undefined) ?? base.database;
    if (!dbName) {
      throw new Error("Tenora: base.database is required.");
    }
    return dbName;
  }

  if (!base.database) {
    throw new Error("Tenora: base.database is required.");
  }
  return base.database;
};

const applyConnectionDefaults = (base: BaseConnectionConfig, conn: Record<string, unknown>) => {
  if (conn.user === undefined && base.user !== undefined) conn.user = base.user;
  if (conn.port === undefined && base.port !== undefined) conn.port = base.port;
  if (isMssqlClient(resolveClient(base.client))) {
    if (conn.server === undefined && base.host !== undefined) conn.server = base.host;
  } else if (conn.host === undefined && base.host !== undefined) {
    conn.host = base.host;
  }
  if (conn.ssl === undefined && base.ssl !== undefined) conn.ssl = base.ssl;
  const normalized = normalizePassword(conn.password ?? base.password);
  if (normalized !== undefined) {
    conn.password = normalized;
  } else {
    delete conn.password;
  }
};

export const buildBaseConnection = (base: BaseConnectionConfig, databaseOverride?: string): Record<string, unknown> => {
  const client = resolveClient(base.client);
  if (base.connection) {
    const conn = { ...base.connection };
    applyConnectionDefaults(base, conn);
    if (databaseOverride !== undefined) {
      if (isSqliteClient(client)) {
        conn.filename = databaseOverride;
        delete conn.database;
      } else {
        conn.database = databaseOverride;
      }
    } else if (isSqliteClient(client)) {
      if (conn.filename === undefined && base.database) conn.filename = base.database;
    } else if (conn.database === undefined && base.database) {
      conn.database = base.database;
    }
    return conn;
  }

  if (isSqliteClient(client)) {
    const filename = databaseOverride ?? base.database;
    if (!filename) {
      throw new Error("Tenora: base.database is required for SQLite.");
    }
    return { filename };
  }

  if (!base.host || !base.user || !base.database) {
    throw new Error("Tenora: base connection is incomplete. Provide base.connection or host/user/database.");
  }

  const conn: Record<string, unknown> = {
    ...(isMssqlClient(client) ? { server: base.host } : { host: base.host }),
    port: base.port,
    user: base.user,
    database: databaseOverride ?? base.database,
    ssl: base.ssl ?? false,
  };
  const basePassword = normalizePassword(base.password);
  if (basePassword !== undefined) conn.password = basePassword;
  return conn;
};

export const resolveAdminDatabase = (base: BaseConnectionConfig): string => {
  const client = resolveClient(base.client);
  return (
    base.adminDatabase ??
    (isPostgresClient(client)
      ? "postgres"
      : isMysqlClient(client)
        ? "mysql"
        : isMssqlClient(client)
          ? "master"
          : resolveBaseDatabaseName(base))
  );
};

export const connect = (
  base: BaseConnectionConfig,
  connection: Record<string, unknown>,
  pool?: PoolOptions
): Connection =>
  createConnection({ client: resolveClient(base.client), dialect: base.dialect, connection, pool });

/** A short-lived connection for statements that run outside the target database, such as CREATE DATABASE. */
export const connectToDatabase = (base: BaseConnectionConfig, database: string): Connection =>
  connect(base, buildBaseConnection(base, database), { max: 1 });
