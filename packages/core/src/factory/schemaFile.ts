import fs from "fs";
import path from "path";
import { type Dialect, listMigrationFiles } from "@tenora/orm";
import type { BaseConnectionConfig, MultiTenantOptions, SchemaDumpStatus } from "../types";
import { readKnexOptions } from "./knexOptions";
import { isMssqlClient, isMysqlClient, isPostgresClient, isSqliteClient, resolveClient } from "./shared";

export type SchemaDialect = Exclude<Dialect, "mssql">;

export type SchemaDump = {
  file: string;
  sql: string;
  /** migration names the dump contains, oldest first */
  migrations: string[];
};

export const DEFAULT_MIGRATIONS_TABLE = "tenora_migrations";

const HEADER = [
  "-- Tenora tenant schema dump, written by `tenora schema:dump:tenants`. Do not edit it by hand.",
  "-- New tenant databases load it, then run only the migrations that are not listed here.",
];
const MIGRATION_LINE = /^-- migration: (.+)$/;
const BOOKKEEPING_LINE = /^-- bookkeeping: (.+)$/;

export const resolveSchemaDialect = (base: BaseConnectionConfig): SchemaDialect | undefined => {
  const client = resolveClient(base.client);
  if (isMssqlClient(client) || base.dialect === "mssql") return undefined;
  if (base.dialect) return base.dialect;
  if (isPostgresClient(client)) return "postgres";
  if (client === "mariadb") return "mariadb";
  if (isMysqlClient(client)) return "mysql";
  if (isSqliteClient(client)) return "sqlite";
  return undefined;
};

export const resolveMigrationsTable = (options: MultiTenantOptions): string =>
  options.migrations?.table ?? DEFAULT_MIGRATIONS_TABLE;

/** The directories the factory reads tenant migrations from; empty when none is configured. */
export const resolveTenantMigrationDirectories = (options: MultiTenantOptions): string[] => {
  const directory = options.tenant?.migrationsDir;
  return readKnexOptions(options).migrationDirectories ?? (directory ? [directory] : []);
};

export const resolveSchemaFile = (options: MultiTenantOptions): string | undefined => {
  const setting = options.tenant?.schemaFile;
  const dialect = resolveSchemaDialect(options.base);
  if (setting === false || !dialect) return undefined;
  if (typeof setting === "string") return setting;
  const [directory] = resolveTenantMigrationDirectories(options);
  return directory ? path.join(path.dirname(directory), "schema", `tenant-${dialect}.sql`) : undefined;
};

const readCache = new Map<string, { mtimeMs: number; size: number; dump: SchemaDump; bookkeeping?: string }>();

const parseDump = (file: string) => {
  const sql = fs.readFileSync(file, "utf8");
  const migrations: string[] = [];
  let bookkeeping: string | undefined;
  for (const line of sql.split("\n")) {
    if (line.trim() && !line.startsWith("--")) break;
    const trimmed = line.trimEnd();
    const migration = MIGRATION_LINE.exec(trimmed);
    if (migration) migrations.push(migration[1]);
    bookkeeping = BOOKKEEPING_LINE.exec(trimmed)?.[1] ?? bookkeeping;
  }
  return { dump: { file, sql, migrations }, bookkeeping };
};

/** Reads a dump, and refuses one whose rows would not land in the table the migrator reads. */
export const readSchemaDump = (file: string, table: string): SchemaDump | undefined => {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  let cached = readCache.get(file);
  if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    cached = { mtimeMs: stat.mtimeMs, size: stat.size, ...parseDump(file) };
    readCache.set(file, cached);
  }
  if (!cached.bookkeeping) {
    throw new Error(
      `Tenora: the schema dump ${file} was written by Tenora 0.x, so it records its migrations in Knex's table. Run tenora upgrade to convert it.`
    );
  }
  if (cached.bookkeeping !== table) {
    throw new Error(
      `Tenora: the schema dump ${file} records its migrations in "${cached.bookkeeping}", but migrations.table is "${table}". Run tenora schema:dump:tenants to write it again.`
    );
  }
  return cached.dump;
};

export const writeSchemaDump = (
  file: string,
  dialect: SchemaDialect,
  table: string,
  migrations: string[],
  body: string
) => {
  const content = [
    ...HEADER,
    `-- dialect: ${dialect}`,
    `-- bookkeeping: ${table}`,
    ...migrations.map((name) => `-- migration: ${name}`),
    "",
    body.trim(),
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** Deletes the migration files whose names the dump contains, and returns their paths. */
export const pruneMigrationFiles = async (directories: string[], dumped: string[]): Promise<string[]> => {
  const names = new Set(dumped);
  const pruned: string[] = [];
  for (const { name, file } of await listMigrationFiles({ directories })) {
    if (!names.has(name)) continue;
    fs.rmSync(file);
    pruned.push(file);
  }
  return pruned;
};

/** Compares the migration files on disk with the dump, without touching a database. */
export const checkTenantSchemaDump = async (options: MultiTenantOptions): Promise<SchemaDumpStatus> => {
  const file = resolveSchemaFile(options);
  const directories = resolveTenantMigrationDirectories(options);
  if (!file || !directories.length) {
    throw new Error(
      "Tenora: schema dumps need tenant.migrationsDir, a client other than SQL Server, and tenant.schemaFile not set to false."
    );
  }
  const dump = readSchemaDump(file, resolveMigrationsTable(options));
  const contained = new Set(dump?.migrations ?? []);
  const missing = (await listMigrationFiles({ directories }))
    .map(({ name }) => name)
    .filter((name) => !contained.has(name));
  return { file, exists: Boolean(dump), missing };
};
