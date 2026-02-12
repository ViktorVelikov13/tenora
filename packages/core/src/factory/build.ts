import fs from "fs";
import knex, { Knex } from "knex";
import path from "path";
import type { MultiTenantOptions, TenantManager } from "../types";
import { ensureRegistryTable, upsertTenantInRegistry } from "../tenantRegistry";
import {
  escapeMssqlIdent,
  escapeMysqlIdent,
  escapePgIdent,
  escapeSqlString,
  isMssqlClient,
  isMysqlClient,
  isPostgresClient,
  isSqliteClient,
  normalizePassword,
  resolveClient,
} from "./shared";

const defaultPool: Knex.PoolConfig = {
  min: 2,
  max: 10,
  acquireTimeoutMillis: 60_000,
  idleTimeoutMillis: 60_000,
};

export const buildTenoraFactory = (resolved: MultiTenantOptions): TenantManager => {
  const { base, tenant = {}, knexOptions = {} } = resolved;
  const cache = new Map<string, Knex>();
  const basePassword = normalizePassword(base.password);
  const client = resolveClient(base.client);

  const resolveBaseDatabaseName = (): string => {
    if (base.connection) {
      const conn = base.connection as unknown as Record<string, unknown>;
      if (isSqliteClient(client)) {
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

  const applyConnectionDefaults = (conn: Record<string, unknown>) => {
    if (conn.user === undefined && base.user !== undefined) conn.user = base.user;
    if (conn.port === undefined && base.port !== undefined) conn.port = base.port;
    if (isMssqlClient(client)) {
      if (conn.server === undefined && base.host !== undefined) conn.server = base.host;
    } else if (conn.host === undefined && base.host !== undefined) {
      conn.host = base.host;
    }
    if (conn.ssl === undefined && base.ssl !== undefined) conn.ssl = base.ssl;
    const normalized = normalizePassword(conn.password ?? basePassword);
    if (normalized !== undefined) {
      conn.password = normalized;
    } else {
      delete conn.password;
    }
  };

  const buildBaseConnection = (databaseOverride?: string): Knex.StaticConnectionConfig => {
    if (base.connection) {
      const conn = { ...(base.connection as unknown as Record<string, unknown>) };
      applyConnectionDefaults(conn);
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
      return conn as Knex.StaticConnectionConfig;
    }

    if (isSqliteClient(client)) {
      const filename = databaseOverride ?? base.database;
      if (!filename) {
        throw new Error("Tenora: base.database is required for SQLite.");
      }
      return { filename } as Knex.StaticConnectionConfig;
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
    if (basePassword !== undefined) conn.password = basePassword;
    return conn as Knex.StaticConnectionConfig;
  };

  const baseKnexConfig: Knex.Config = {
    client,
    useNullAsDefault: true,
    connection: buildBaseConnection(resolveBaseDatabaseName()),
    pool: base.pool ?? defaultPool,
    migrations: base.migrationsDir ? { directory: base.migrationsDir } : undefined,
    seeds: base.seedsDir ? { directory: base.seedsDir } : undefined,
    ...knexOptions,
  } as Knex.Config;

  const baseClient = knex(baseKnexConfig);

  const resolveTenantDatabaseName = (tenantId: string): string =>
    tenant.databaseName ? tenant.databaseName(tenantId) : tenantId;

  const resolveSqliteTenantFilename = (tenantId: string): string => {
    const baseDb = resolveBaseDatabaseName();
    const baseDir = tenant.databaseDir ?? path.dirname(baseDb ?? process.cwd());
    const name = tenant.databaseName
      ? tenant.databaseName(tenantId)
      : `${tenantId}${tenant.databaseSuffix ?? ".sqlite"}`;
    return path.isAbsolute(name) ? name : path.join(baseDir, name);
  };

  const buildTenantConfig = (tenantId: string, password?: string): Knex.Config => {
    const tenantPassword = normalizePassword(password ?? basePassword);
    const hasTenantPassword = password !== undefined && password !== null;
    const tenantDb = isSqliteClient(client)
      ? resolveSqliteTenantFilename(tenantId)
      : resolveTenantDatabaseName(tenantId);
    const connection = buildBaseConnection(tenantDb) as Record<string, unknown>;

    if (!isSqliteClient(client) && hasTenantPassword) {
      connection.user = `${tenant.userPrefix ?? "user_"}${tenantId}`;
      if (tenantPassword !== undefined) {
        connection.password = tenantPassword;
      } else {
        delete connection.password;
      }
    }

    if (tenant.ssl !== undefined) {
      connection.ssl = tenant.ssl;
    }

    return {
      client,
      useNullAsDefault: true,
      connection,
      pool: tenant.pool ?? base.pool ?? defaultPool,
      migrations: tenant.migrationsDir ? { directory: tenant.migrationsDir } : undefined,
      seeds: tenant.seedsDir ? { directory: tenant.seedsDir } : undefined,
      ...knexOptions,
    };
  };

  const getTenant = (tenantId: string, password?: string): Knex => {
    const cached = cache.get(tenantId);
    if (cached) return cached;

    const tenantClient = knex(buildTenantConfig(tenantId, password));
    cache.set(tenantId, tenantClient);
    return tenantClient;
  };

  const destroyTenant = async (tenantId: string) => {
    const tenantClient = cache.get(tenantId);
    if (tenantClient) {
      await tenantClient.destroy();
      cache.delete(tenantId);
    }
  };

  const destroyAll = async () => {
    await Promise.all([...cache.values()].map((k) => k.destroy()));
    cache.clear();
    await baseClient.destroy();
  };

  const createTenantDb = async (tenantId: string, password?: string) => {
    await ensureRegistryTable(baseClient, resolved);
    const tenantPassword = normalizePassword(password);
    const hasTenantPassword = password !== undefined && password !== null;

    if (isSqliteClient(client)) {
      const filename = resolveSqliteTenantFilename(tenantId);
      if (filename !== ":memory:") {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        if (!fs.existsSync(filename)) {
          fs.closeSync(fs.openSync(filename, "a"));
        }
      }
    } else {
      const adminDb =
        base.adminDatabase ??
        (isPostgresClient(client)
          ? "postgres"
          : isMysqlClient(client)
            ? "mysql"
            : isMssqlClient(client)
              ? "master"
              : resolveBaseDatabaseName());
      const admin = knex({
        ...baseKnexConfig,
        connection: buildBaseConnection(adminDb),
      });

      try {
        if (isPostgresClient(client)) {
          const result = await admin.raw(`SELECT 1 FROM pg_database WHERE datname = ?`, [tenantId]);
          if (result?.rows?.length) {
            throw new Error(`Database "${tenantId}" already exists`);
          }

          const safeDb = escapePgIdent(tenantId);
          await admin.raw(`CREATE DATABASE "${safeDb}"`);

          if (tenantPassword && hasTenantPassword) {
            const userName = `${tenant.userPrefix ?? "user_"}${tenantId}`;
            const safeUser = escapePgIdent(userName);
            const safePwd = escapeSqlString(tenantPassword);
            await admin.raw(`CREATE USER "${safeUser}" WITH PASSWORD '${safePwd}'`);
            await admin.raw(`GRANT ALL PRIVILEGES ON DATABASE "${safeDb}" TO "${safeUser}"`);
          }
        } else if (isMysqlClient(client)) {
          const result = await admin.raw(
            `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?`,
            [tenantId]
          );
          if (result?.[0]?.length) {
            throw new Error(`Database "${tenantId}" already exists`);
          }

          const safeDb = escapeMysqlIdent(tenantId);
          await admin.raw(`CREATE DATABASE \`${safeDb}\``);

          if (tenantPassword && hasTenantPassword) {
            const userName = `${tenant.userPrefix ?? "user_"}${tenantId}`;
            const safeUser = escapeSqlString(userName);
            const safePwd = escapeSqlString(tenantPassword);
            await admin.raw(`CREATE USER IF NOT EXISTS '${safeUser}'@'%' IDENTIFIED BY '${safePwd}'`);
            await admin.raw(`GRANT ALL PRIVILEGES ON \`${safeDb}\`.* TO '${safeUser}'@'%'`);
          }
        } else if (isMssqlClient(client)) {
          const safeDb = escapeMssqlIdent(tenantId);
          await admin.raw(
            `IF DB_ID(N'${escapeSqlString(tenantId)}') IS NULL CREATE DATABASE [${safeDb}]`
          );

          if (tenantPassword && hasTenantPassword) {
            const userName = `${tenant.userPrefix ?? "user_"}${tenantId}`;
            const safeUser = escapeMssqlIdent(userName);
            const safePwd = escapeSqlString(tenantPassword);
            await admin.raw(
              `IF NOT EXISTS (SELECT name FROM sys.server_principals WHERE name = N'${escapeSqlString(userName)}') CREATE LOGIN [${safeUser}] WITH PASSWORD = '${safePwd}'`
            );

            const tenantAdmin = knex({
              ...baseKnexConfig,
              connection: buildBaseConnection(tenantId),
            });
            try {
              await tenantAdmin.raw(
                `IF NOT EXISTS (SELECT name FROM sys.database_principals WHERE name = N'${escapeSqlString(userName)}') CREATE USER [${safeUser}] FOR LOGIN [${safeUser}]`
              );
              await tenantAdmin.raw(`EXEC sp_addrolemember 'db_owner', '${safeUser}'`);
            } finally {
              await tenantAdmin.destroy();
            }
          }
        } else {
          throw new Error(
            `Tenora: createTenantDb is only supported for Postgres, MySQL/MariaDB, SQLite, and SQL Server clients (got "${client}").`
          );
        }
      } finally {
        await admin.destroy();
      }
    }

    const tenantKnex = knex(buildTenantConfig(tenantId, tenantPassword));
    try {
      if (tenant.migrationsDir) {
        await tenantKnex.migrate.latest();
      }
      if (tenant.seedsDir) {
        await tenantKnex.seed.run();
      }
    } finally {
      await tenantKnex.destroy();
      cache.delete(tenantId);
    }

    await upsertTenantInRegistry(baseClient, resolved, tenantId, password);
  };

  return {
    getBase: () => baseClient,
    getTenant,
    createTenantDb,
    destroyTenant,
    destroyAll,
  };
};
