import { randomBytes } from "crypto";
import fs from "fs";
import type { Knex } from "knex";
import os from "os";
import path from "path";
import type {
  DropTenantOptions,
  MultiTenantOptions,
  SchemaDumpOptions,
  SchemaDumpResult,
  TenantManager,
} from "../types";
import {
  ensureRegistryTable,
  listTenantsFromRegistry,
  removeTenantFromRegistry,
  upsertTenantInRegistry,
} from "../tenantRegistry";
import { resolveKnex } from "../runtime/resolveKnex";
import {
  pruneMigrationFiles,
  readSchemaDump,
  resolveSchemaDialect,
  resolveSchemaFile,
  resolveTenantMigrations,
  withSchemaDumpMigrations,
  writeSchemaDump,
  type SchemaDump,
} from "./schemaFile";
import { dumpMysql, dumpPostgres, dumpSqlite, loadSchemaSql, type MigrationTables } from "./schemaSql";
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

const SYSTEM_DATABASES = [
  "postgres",
  "template0",
  "template1",
  "mysql",
  "information_schema",
  "performance_schema",
  "sys",
  "master",
  "model",
  "msdb",
  "tempdb",
];

export const buildTenoraFactory = (resolved: MultiTenantOptions): TenantManager => {
  const knex = resolveKnex();
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

  const tenantMigrations = resolveTenantMigrations(resolved);
  const schemaFile = resolveSchemaFile(resolved);
  const schemaDialect = resolveSchemaDialect(client);
  const migrationTables: MigrationTables = {
    tableName: tenantMigrations?.tableName ?? "knex_migrations",
    schemaName: tenantMigrations?.schemaName ?? undefined,
  };
  const currentSchemaDump = () => (schemaFile ? readSchemaDump(schemaFile) : undefined);

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

  const resolveTenantDatabase = (tenantId: string): string =>
    isSqliteClient(client)
      ? resolveSqliteTenantFilename(tenantId)
      : resolveTenantDatabaseName(tenantId);

  const resolveTenantUserName = (tenantId: string): string =>
    `${tenant.userPrefix ?? "user_"}${tenantId}`;

  const resolveAdminDatabase = (): string =>
    base.adminDatabase ??
    (isPostgresClient(client)
      ? "postgres"
      : isMysqlClient(client)
        ? "mysql"
        : isMssqlClient(client)
          ? "master"
          : resolveBaseDatabaseName());

  const isProtectedDatabase = (database: string): boolean => {
    if (isSqliteClient(client)) {
      return path.resolve(database) === path.resolve(resolveBaseDatabaseName());
    }
    return [resolveBaseDatabaseName(), resolveAdminDatabase(), ...SYSTEM_DATABASES].some(
      (name) => name.toLowerCase() === database.toLowerCase()
    );
  };

  const buildTenantConfig = (tenantId: string, password?: string): Knex.Config => {
    const tenantPassword = normalizePassword(password ?? basePassword);
    const hasTenantPassword = password !== undefined && password !== null;
    const connection = buildBaseConnection(resolveTenantDatabase(tenantId)) as Record<string, unknown>;

    if (!isSqliteClient(client) && hasTenantPassword) {
      connection.user = resolveTenantUserName(tenantId);
      if (tenantPassword !== undefined) {
        connection.password = tenantPassword;
      } else {
        delete connection.password;
      }
    }

    if (tenant.ssl !== undefined) {
      connection.ssl = tenant.ssl;
    }

    const config: Knex.Config = {
      client,
      useNullAsDefault: true,
      connection,
      pool: tenant.pool ?? base.pool ?? defaultPool,
      migrations: tenant.migrationsDir ? { directory: tenant.migrationsDir } : undefined,
      seeds: tenant.seedsDir ? { directory: tenant.seedsDir } : undefined,
      ...knexOptions,
    };
    const dump = currentSchemaDump();
    if (dump && config.migrations) {
      config.migrations = withSchemaDumpMigrations(config.migrations, dump);
    }
    return config;
  };

  const migrationsTable = (db: Knex) =>
    migrationTables.schemaName
      ? db(migrationTables.tableName).withSchema(migrationTables.schemaName)
      : db(migrationTables.tableName);

  const hasMigrationsTable = (db: Knex) =>
    (migrationTables.schemaName ? db.schema.withSchema(migrationTables.schemaName) : db.schema).hasTable(
      migrationTables.tableName
    );

  // A connection of its own: Postgres dumps clear search_path for the rest of the session, and
  // MySQL needs multipleStatements to load the dump in one round trip.
  const loadSchemaDump = async (config: Knex.Config, dump: SchemaDump) => {
    const connection = isMysqlClient(client)
      ? { ...(config.connection as Record<string, unknown>), multipleStatements: true }
      : config.connection;
    const loader = knex({ ...config, connection, pool: { min: 0, max: 1 } } as Knex.Config);
    try {
      await loadSchemaSql(loader, client, dump.sql);
    } catch (error) {
      throw new Error(`Tenora: loading the schema dump ${dump.file} failed: ${(error as Error).message}`);
    } finally {
      await loader.destroy();
    }
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
      const tenantDb = resolveTenantDatabaseName(tenantId);
      const admin = knex({
        ...baseKnexConfig,
        connection: buildBaseConnection(resolveAdminDatabase()),
      });

      try {
        if (isPostgresClient(client)) {
          const result = await admin.raw(`SELECT 1 FROM pg_database WHERE datname = ?`, [tenantDb]);
          if (result?.rows?.length) {
            throw new Error(`Database "${tenantDb}" already exists`);
          }

          const safeDb = escapePgIdent(tenantDb);
          await admin.raw(`CREATE DATABASE "${safeDb}"`);

          if (tenantPassword && hasTenantPassword) {
            const userName = resolveTenantUserName(tenantId);
            const safeUser = escapePgIdent(userName);
            const safePwd = escapeSqlString(tenantPassword);
            await admin.raw(`CREATE USER "${safeUser}" WITH PASSWORD '${safePwd}'`);
            await admin.raw(`GRANT ALL PRIVILEGES ON DATABASE "${safeDb}" TO "${safeUser}"`);

            // Since Postgres 15 only the database owner can create objects in the public schema.
            const tenantAdmin = knex({
              ...baseKnexConfig,
              connection: buildBaseConnection(tenantDb),
            });
            try {
              await tenantAdmin.raw(`GRANT ALL ON SCHEMA public TO "${safeUser}"`);
            } finally {
              await tenantAdmin.destroy();
            }
          }
        } else if (isMysqlClient(client)) {
          const result = await admin.raw(
            `SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?`,
            [tenantDb]
          );
          if (result?.[0]?.length) {
            throw new Error(`Database "${tenantDb}" already exists`);
          }

          const safeDb = escapeMysqlIdent(tenantDb);
          await admin.raw(`CREATE DATABASE \`${safeDb}\``);

          if (tenantPassword && hasTenantPassword) {
            const userName = resolveTenantUserName(tenantId);
            const safeUser = escapeSqlString(userName);
            const safePwd = escapeSqlString(tenantPassword);
            await admin.raw(`CREATE USER IF NOT EXISTS '${safeUser}'@'%' IDENTIFIED BY '${safePwd}'`);
            await admin.raw(`GRANT ALL PRIVILEGES ON \`${safeDb}\`.* TO '${safeUser}'@'%'`);
          }
        } else if (isMssqlClient(client)) {
          const safeDb = escapeMssqlIdent(tenantDb);
          await admin.raw(
            `IF DB_ID(N'${escapeSqlString(tenantDb)}') IS NULL CREATE DATABASE [${safeDb}]`
          );

          if (tenantPassword && hasTenantPassword) {
            const userName = resolveTenantUserName(tenantId);
            const safeUser = escapeMssqlIdent(userName);
            const safePwd = escapeSqlString(tenantPassword);
            await admin.raw(
              `IF NOT EXISTS (SELECT name FROM sys.server_principals WHERE name = N'${escapeSqlString(userName)}') CREATE LOGIN [${safeUser}] WITH PASSWORD = '${safePwd}'`
            );

            const tenantAdmin = knex({
              ...baseKnexConfig,
              connection: buildBaseConnection(tenantDb),
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

    const tenantConfig = buildTenantConfig(tenantId, tenantPassword);
    const tenantKnex = knex(tenantConfig);
    try {
      // Only into a database with no migrations yet; a reused SQLite file may already have them.
      const dump = currentSchemaDump();
      if (dump && !(await hasMigrationsTable(tenantKnex))) {
        await loadSchemaDump(tenantConfig, dump);
      }
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

  const dropTenantDb = async (tenantId: string, options: DropTenantOptions = {}) => {
    const tenantDb = resolveTenantDatabase(tenantId);
    if (isProtectedDatabase(tenantDb)) {
      throw new Error(`Tenora: refusing to drop protected database "${tenantDb}".`);
    }

    const tenants = await listTenantsFromRegistry(baseClient, resolved);
    if (!options.allowUnregistered && !tenants.some((record) => record.id === tenantId)) {
      throw new Error(
        `Tenora: tenant "${tenantId}" is not in the registry, so nothing was dropped.`
      );
    }

    await destroyTenant(tenantId);

    if (isSqliteClient(client)) {
      if (tenantDb !== ":memory:") {
        for (const file of [tenantDb, `${tenantDb}-wal`, `${tenantDb}-shm`]) {
          fs.rmSync(file, { force: true });
        }
      }
    } else {
      const userName = resolveTenantUserName(tenantId);
      const admin = knex({
        ...baseKnexConfig,
        connection: buildBaseConnection(resolveAdminDatabase()),
      });

      try {
        if (isPostgresClient(client)) {
          await admin.raw(`DROP DATABASE IF EXISTS "${escapePgIdent(tenantDb)}" WITH (FORCE)`);
          await admin.raw(`DROP ROLE IF EXISTS "${escapePgIdent(userName)}"`);
        } else if (isMysqlClient(client)) {
          await admin.raw(`DROP DATABASE IF EXISTS \`${escapeMysqlIdent(tenantDb)}\``);
          await admin.raw(`DROP USER IF EXISTS '${escapeSqlString(userName)}'@'%'`);
        } else if (isMssqlClient(client)) {
          const safeDb = escapeMssqlIdent(tenantDb);
          await admin.raw(
            `IF DB_ID(N'${escapeSqlString(tenantDb)}') IS NOT NULL BEGIN ALTER DATABASE [${safeDb}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${safeDb}]; END`
          );
          await admin.raw(
            `IF SUSER_ID(N'${escapeSqlString(userName)}') IS NOT NULL DROP LOGIN [${escapeMssqlIdent(userName)}]`
          );
        } else {
          throw new Error(
            `Tenora: dropTenantDb is only supported for Postgres, MySQL/MariaDB, SQLite, and SQL Server clients (got "${client}").`
          );
        }
      } finally {
        await admin.destroy();
      }
    }

    // Last, so a failed drop keeps the tenant listed and can simply be retried.
    await removeTenantFromRegistry(baseClient, resolved, tenantId);
  };

  const createScratchDatabase = async (database: string) => {
    if (isSqliteClient(client)) return;
    const admin = knex({ ...baseKnexConfig, connection: buildBaseConnection(resolveAdminDatabase()) });
    try {
      if (isPostgresClient(client)) {
        await admin.raw(`CREATE DATABASE "${escapePgIdent(database)}"`);
      } else {
        await admin.raw(`CREATE DATABASE \`${escapeMysqlIdent(database)}\``);
      }
    } finally {
      await admin.destroy();
    }
  };

  const dropScratchDatabase = async (database: string) => {
    if (isSqliteClient(client)) {
      for (const file of [database, `${database}-wal`, `${database}-shm`]) {
        fs.rmSync(file, { force: true });
      }
      return;
    }
    const admin = knex({ ...baseKnexConfig, connection: buildBaseConnection(resolveAdminDatabase()) });
    try {
      if (isPostgresClient(client)) {
        await admin.raw(`DROP DATABASE IF EXISTS "${escapePgIdent(database)}" WITH (FORCE)`);
      } else {
        await admin.raw(`DROP DATABASE IF EXISTS \`${escapeMysqlIdent(database)}\``);
      }
    } finally {
      await admin.destroy();
    }
  };

  /**
   * Builds the schema in a throwaway database rather than copying a tenant, so the dump holds exactly
   * what the migrations produce. A previous dump is loaded first, because pruned migrations cannot run.
   */
  const dumpTenantSchema = async (options: SchemaDumpOptions = {}): Promise<SchemaDumpResult> => {
    if (!schemaDialect || !schemaFile || !tenantMigrations?.directory) {
      throw new Error(
        `Tenora: schema dumps need tenant.migrationsDir, a client other than SQL Server, and tenant.schemaFile not set to false (client is "${client}").`
      );
    }
    const previous = currentSchemaDump();
    const suffix = randomBytes(6).toString("hex");
    const scratch = isSqliteClient(client)
      ? path.join(os.tmpdir(), `tenora_schema_${suffix}.sqlite`)
      : `tenora_schema_${suffix}`;
    const scratchConfig: Knex.Config = {
      ...baseKnexConfig,
      connection: buildBaseConnection(scratch),
      pool: { min: 0, max: 1 },
      migrations: previous ? withSchemaDumpMigrations(tenantMigrations, previous) : tenantMigrations,
    };

    let migrations: string[] = [];
    let body = "";
    await createScratchDatabase(scratch);
    try {
      if (previous) await loadSchemaDump(scratchConfig, previous);
      const scratchKnex = knex(scratchConfig);
      try {
        await scratchKnex.migrate.latest();
        const rows: { name: string }[] = await migrationsTable(scratchKnex).select("name").orderBy("id");
        migrations = rows.map((row) => row.name);
        const connection = scratchConfig.connection as Record<string, unknown>;
        body =
          schemaDialect === "sqlite"
            ? await dumpSqlite(scratchKnex, migrationTables)
            : schemaDialect === "postgres"
              ? await dumpPostgres(connection, scratch, migrationTables)
              : await dumpMysql(schemaDialect, connection, scratch, migrationTables);
      } finally {
        await scratchKnex.destroy();
      }
    } finally {
      await dropScratchDatabase(scratch);
    }

    writeSchemaDump(schemaFile, schemaDialect, migrations, body);
    const pruned = options.prune ? await pruneMigrationFiles(tenantMigrations, migrations) : [];
    return { file: schemaFile, migrations, pruned };
  };

  return {
    getBase: () => baseClient,
    getTenant,
    createTenantDb,
    dropTenantDb,
    dumpTenantSchema,
    destroyTenant,
    destroyAll,
  };
};
