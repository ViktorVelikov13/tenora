import { randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { type Connection, createMigrator, createSeeder, type PoolOptions, sql } from "@tenora/orm";
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
import {
  buildBaseConnection,
  connect,
  connectToDatabase,
  resolveAdminDatabase,
  resolveBaseDatabaseName,
} from "./connection";
import { readKnexOptions } from "./knexOptions";
import {
  pruneMigrationFiles,
  readSchemaDump,
  resolveMigrationsTable,
  resolveSchemaDialect,
  resolveSchemaFile,
  resolveTenantMigrationDirectories,
  writeSchemaDump,
  type SchemaDump,
} from "./schemaFile";
import { dumpMysql, dumpPostgres, dumpSqlite, loadSchemaSql } from "./schemaSql";
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
  runText,
} from "./shared";

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
  const { base, tenant = {} } = resolved;
  const knexOptions = readKnexOptions(resolved);
  const cache = new Map<string, Connection>();
  const basePassword = normalizePassword(base.password);
  const client = resolveClient(base.client);
  const basePool: PoolOptions | undefined = knexOptions.pool ?? base.pool;
  const tenantPool: PoolOptions | undefined = knexOptions.pool ?? tenant.pool ?? base.pool;

  const baseClient = connect(base, buildBaseConnection(base, resolveBaseDatabaseName(base)), basePool);

  const migrationsTable = resolveMigrationsTable(resolved);
  const tenantMigrations = resolveTenantMigrationDirectories(resolved);
  const baseMigrations = knexOptions.migrationDirectories ?? (base.migrationsDir ? [base.migrationsDir] : []);
  const baseSeeds = knexOptions.seedDirectories ?? (base.seedsDir ? [base.seedsDir] : []);
  const tenantSeeds = knexOptions.seedDirectories ?? (tenant.seedsDir ? [tenant.seedsDir] : []);
  const schemaFile = resolveSchemaFile(resolved);
  const schemaDialect = resolveSchemaDialect(base);
  const currentSchemaDump = () => (schemaFile ? readSchemaDump(schemaFile, migrationsTable) : undefined);

  const resolveTenantDatabaseName = (tenantId: string): string =>
    tenant.databaseName ? tenant.databaseName(tenantId) : tenantId;

  const resolveSqliteTenantFilename = (tenantId: string): string => {
    const baseDb = resolveBaseDatabaseName(base);
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

  const isProtectedDatabase = (database: string): boolean => {
    if (isSqliteClient(client)) {
      return path.resolve(database) === path.resolve(resolveBaseDatabaseName(base));
    }
    return [resolveBaseDatabaseName(base), resolveAdminDatabase(base), ...SYSTEM_DATABASES].some(
      (name) => name.toLowerCase() === database.toLowerCase()
    );
  };

  const buildTenantConnection = (tenantId: string, password?: string): Record<string, unknown> => {
    const tenantPassword = normalizePassword(password ?? basePassword);
    const hasTenantPassword = password !== undefined && password !== null;
    const connection = buildBaseConnection(base, resolveTenantDatabase(tenantId));

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

    return connection;
  };

  const needing = (directories: string[], setting: string, work: string) => {
    if (!directories.length) throw new Error(`Tenora: ${setting} is required to ${work}.`);
    return directories;
  };

  const migratorFor = (db: Connection, directories: string[], setting: string) =>
    createMigrator(db, { directories: needing(directories, setting, "run migrations"), table: migrationsTable });

  /** A tenant's migrator knows which migrations the dump contains, so one that never ran them is told so. */
  const tenantMigratorFor = (db: Connection) => {
    const dump = currentSchemaDump();
    return createMigrator(db, {
      directories: needing(tenantMigrations, "tenant.migrationsDir", "run migrations"),
      table: migrationsTable,
      pruned: dump && { migrations: dump.migrations, into: dump.file },
    });
  };

  const seederFor = (db: Connection, directories: string[], setting: string) =>
    createSeeder(db, { directories: needing(directories, setting, "run seeds") });

  // A connection of its own, because a Postgres dump clears search_path for the rest of the session.
  const loadSchemaDump = async (connection: Record<string, unknown>, dump: SchemaDump) => {
    const loader = connect(base, connection, { max: 1 });
    try {
      await loadSchemaSql(loader, dump.sql);
    } catch (error) {
      throw new Error(`Tenora: loading the schema dump ${dump.file} failed: ${(error as Error).message}`);
    } finally {
      await loader.destroy();
    }
  };

  const getTenant = (tenantId: string, password?: string): Connection => {
    const cached = cache.get(tenantId);
    if (cached) return cached;

    const tenantClient = connect(base, buildTenantConnection(tenantId, password), tenantPool);
    cache.set(tenantId, tenantClient);
    return tenantClient;
  };

  const destroyTenant = async (tenantId: string) => {
    const tenantClient = cache.get(tenantId);
    if (tenantClient) {
      cache.delete(tenantId);
      await tenantClient.destroy();
    }
  };

  const destroyAll = async () => {
    await Promise.all([...cache.values()].map((db) => db.destroy()));
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
      const admin = connectToDatabase(base, resolveAdminDatabase(base));

      try {
        if (isPostgresClient(client)) {
          const existing = await admin.raw(sql`SELECT 1 FROM pg_database WHERE datname = ${tenantDb}`);
          if (existing.length) {
            throw new Error(`Database "${tenantDb}" already exists`);
          }

          const safeDb = escapePgIdent(tenantDb);
          await runText(admin, `CREATE DATABASE "${safeDb}"`);

          if (tenantPassword && hasTenantPassword) {
            const userName = resolveTenantUserName(tenantId);
            const safeUser = escapePgIdent(userName);
            const safePwd = escapeSqlString(tenantPassword);
            await runText(admin, `CREATE USER "${safeUser}" WITH PASSWORD '${safePwd}'`);
            await runText(admin, `GRANT ALL PRIVILEGES ON DATABASE "${safeDb}" TO "${safeUser}"`);

            // Since Postgres 15 only the database owner can create objects in the public schema.
            const tenantAdmin = connectToDatabase(base, tenantDb);
            try {
              await runText(tenantAdmin, `GRANT ALL ON SCHEMA public TO "${safeUser}"`);
            } finally {
              await tenantAdmin.destroy();
            }
          }
        } else if (isMysqlClient(client)) {
          const existing = await admin.raw(sql`SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ${tenantDb}`);
          if (existing.length) {
            throw new Error(`Database "${tenantDb}" already exists`);
          }

          const safeDb = escapeMysqlIdent(tenantDb);
          await runText(admin, `CREATE DATABASE \`${safeDb}\``);

          if (tenantPassword && hasTenantPassword) {
            const userName = resolveTenantUserName(tenantId);
            const safeUser = escapeSqlString(userName);
            const safePwd = escapeSqlString(tenantPassword);
            await runText(admin, `CREATE USER IF NOT EXISTS '${safeUser}'@'%' IDENTIFIED BY '${safePwd}'`);
            await runText(admin, `GRANT ALL PRIVILEGES ON \`${safeDb}\`.* TO '${safeUser}'@'%'`);
          }
        } else if (isMssqlClient(client)) {
          const safeDb = escapeMssqlIdent(tenantDb);
          await runText(admin, `IF DB_ID(N'${escapeSqlString(tenantDb)}') IS NULL CREATE DATABASE [${safeDb}]`);

          if (tenantPassword && hasTenantPassword) {
            const userName = resolveTenantUserName(tenantId);
            const safeUser = escapeMssqlIdent(userName);
            const safePwd = escapeSqlString(tenantPassword);
            await runText(
              admin,
              `IF NOT EXISTS (SELECT name FROM sys.server_principals WHERE name = N'${escapeSqlString(userName)}') CREATE LOGIN [${safeUser}] WITH PASSWORD = '${safePwd}'`
            );

            const tenantAdmin = connectToDatabase(base, tenantDb);
            try {
              await runText(
                tenantAdmin,
                `IF NOT EXISTS (SELECT name FROM sys.database_principals WHERE name = N'${escapeSqlString(userName)}') CREATE USER [${safeUser}] FOR LOGIN [${safeUser}]`
              );
              await runText(tenantAdmin, `EXEC sp_addrolemember 'db_owner', '${safeUser}'`);
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

    const connection = buildTenantConnection(tenantId, tenantPassword);
    const tenantClient = connect(base, connection, tenantPool);
    try {
      // Only into a database with no migrations yet; a reused SQLite file may already have them.
      const dump = currentSchemaDump();
      if (dump && !(await tenantClient.schema.hasTable(migrationsTable))) {
        await loadSchemaDump(connection, dump);
      }
      if (tenantMigrations.length) {
        await tenantMigratorFor(tenantClient).latest();
      }
      if (tenantSeeds.length) {
        await seederFor(tenantClient, tenantSeeds, "tenant.seedsDir").run();
      }
    } finally {
      await tenantClient.destroy();
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
      const admin = connectToDatabase(base, resolveAdminDatabase(base));

      try {
        if (isPostgresClient(client)) {
          await runText(admin, `DROP DATABASE IF EXISTS "${escapePgIdent(tenantDb)}" WITH (FORCE)`);
          await runText(admin, `DROP ROLE IF EXISTS "${escapePgIdent(userName)}"`);
        } else if (isMysqlClient(client)) {
          await runText(admin, `DROP DATABASE IF EXISTS \`${escapeMysqlIdent(tenantDb)}\``);
          await runText(admin, `DROP USER IF EXISTS '${escapeSqlString(userName)}'@'%'`);
        } else if (isMssqlClient(client)) {
          const safeDb = escapeMssqlIdent(tenantDb);
          await runText(
            admin,
            `IF DB_ID(N'${escapeSqlString(tenantDb)}') IS NOT NULL BEGIN ALTER DATABASE [${safeDb}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${safeDb}]; END`
          );
          await runText(
            admin,
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
    const admin = connectToDatabase(base, resolveAdminDatabase(base));
    try {
      if (isPostgresClient(client)) {
        await runText(admin, `CREATE DATABASE "${escapePgIdent(database)}"`);
      } else {
        await runText(admin, `CREATE DATABASE \`${escapeMysqlIdent(database)}\``);
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
    const admin = connectToDatabase(base, resolveAdminDatabase(base));
    try {
      if (isPostgresClient(client)) {
        await runText(admin, `DROP DATABASE IF EXISTS "${escapePgIdent(database)}" WITH (FORCE)`);
      } else {
        await runText(admin, `DROP DATABASE IF EXISTS \`${escapeMysqlIdent(database)}\``);
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
    if (!schemaDialect || !schemaFile || !tenantMigrations.length) {
      throw new Error(
        `Tenora: schema dumps need tenant.migrationsDir, a client other than SQL Server, and tenant.schemaFile not set to false (client is "${client}").`
      );
    }
    const previous = currentSchemaDump();
    const suffix = randomBytes(6).toString("hex");
    const scratch = isSqliteClient(client)
      ? path.join(os.tmpdir(), `tenora_schema_${suffix}.sqlite`)
      : `tenora_schema_${suffix}`;
    const connection = buildBaseConnection(base, scratch);

    let migrations: string[] = [];
    let body = "";
    await createScratchDatabase(scratch);
    try {
      if (previous) await loadSchemaDump(connection, previous);
      const scratchClient = connect(base, connection, { max: 1 });
      try {
        await migratorFor(scratchClient, tenantMigrations, "tenant.migrationsDir").latest();
        migrations = await scratchClient.table<{ name: string }>(migrationsTable).orderBy("id").pluck("name");
        body =
          schemaDialect === "sqlite"
            ? await dumpSqlite(scratchClient, migrationsTable)
            : schemaDialect === "postgres"
              ? await dumpPostgres(connection, scratch, migrationsTable)
              : await dumpMysql(schemaDialect, connection, scratch, migrationsTable);
      } finally {
        await scratchClient.destroy();
      }
    } finally {
      await dropScratchDatabase(scratch);
    }

    writeSchemaDump(schemaFile, schemaDialect, migrationsTable, migrations, body);
    const pruned = options.prune ? await pruneMigrationFiles(tenantMigrations, migrations) : [];
    return { file: schemaFile, migrations, pruned };
  };

  return {
    getBase: () => baseClient,
    getTenant,
    baseMigrator: () => migratorFor(baseClient, baseMigrations, "base.migrationsDir"),
    tenantMigrator: (tenantId, password) => tenantMigratorFor(getTenant(tenantId, password)),
    baseSeeder: () => seederFor(baseClient, baseSeeds, "base.seedsDir"),
    tenantSeeder: (tenantId, password) => seederFor(getTenant(tenantId, password), tenantSeeds, "tenant.seedsDir"),
    createTenantDb,
    dropTenantDb,
    dumpTenantSchema,
    destroyTenant,
    destroyAll,
  };
};
