import fs from "fs";
import type { Knex } from "knex";
import path from "path";
import type { MultiTenantOptions, SchemaDumpStatus, TenoraClient } from "../types";
import { resolveKnexRequire } from "../runtime/resolveKnex";
import { isMysqlClient, isPostgresClient, isSqliteClient, resolveClient } from "./shared";

export type SchemaDialect = "postgres" | "mysql" | "mariadb" | "sqlite";

export type SchemaDump = {
  file: string;
  sql: string;
  /** migration names the dump contains, oldest first */
  migrations: string[];
};

type MigrationSource = Knex.MigrationSource<unknown>;
type FsMigrationsClass = new (
  directories: string | readonly string[],
  sortDirsSeparately?: boolean,
  loadExtensions?: readonly string[]
) => MigrationSource;

const HEADER = [
  "-- Tenora tenant schema dump, written by `tenora schema:dump:tenants`. Do not edit it by hand.",
  "-- New tenant databases load it, then run only the migrations that are not listed here.",
];
const MIGRATION_LINE = /^-- migration: (.+)$/;

export const resolveSchemaDialect = (client: TenoraClient): SchemaDialect | undefined => {
  if (isPostgresClient(client)) return "postgres";
  if (client === "mariadb") return "mariadb";
  if (isMysqlClient(client)) return "mysql";
  if (isSqliteClient(client)) return "sqlite";
  return undefined;
};

/** The tenant migration config exactly as the factory hands it to Knex. */
export const resolveTenantMigrations = (
  options: MultiTenantOptions
): Knex.MigratorConfig | undefined => {
  const knexOptions = (options.knexOptions ?? {}) as Knex.Config;
  if ("migrations" in knexOptions) return knexOptions.migrations;
  const directory = options.tenant?.migrationsDir;
  return directory ? { directory } : undefined;
};

const migrationDirectories = (migrations: Knex.MigratorConfig | undefined): string[] => {
  const directory = migrations?.directory;
  if (!directory) return [];
  return Array.isArray(directory) ? [...directory] : [directory as string];
};

export const resolveSchemaFile = (options: MultiTenantOptions): string | undefined => {
  const setting = options.tenant?.schemaFile;
  const dialect = resolveSchemaDialect(resolveClient(options.base.client));
  if (setting === false || !dialect) return undefined;
  if (typeof setting === "string") return setting;
  const [directory] = migrationDirectories(resolveTenantMigrations(options));
  return directory ? path.join(path.dirname(directory), "schema", `tenant-${dialect}.sql`) : undefined;
};

const readCache = new Map<string, { mtimeMs: number; size: number; dump: SchemaDump }>();

export const readSchemaDump = (file: string): SchemaDump | undefined => {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  const cached = readCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.dump;

  const sql = fs.readFileSync(file, "utf8");
  const migrations: string[] = [];
  for (const line of sql.split("\n")) {
    if (line.trim() && !line.startsWith("--")) break;
    const match = MIGRATION_LINE.exec(line.trimEnd());
    if (match) migrations.push(match[1]);
  }
  const dump = { file, sql, migrations };
  readCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, dump });
  return dump;
};

export const writeSchemaDump = (
  file: string,
  dialect: SchemaDialect,
  migrations: string[],
  body: string
) => {
  const content = [
    ...HEADER,
    `-- dialect: ${dialect}`,
    ...migrations.map((name) => `-- migration: ${name}`),
    "",
    body.trim(),
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const loadFsMigrations = (): FsMigrationsClass =>
  resolveKnexRequire()("./lib/migrations/migrate/sources/fs-migrations").FsMigrations;

type PrunedMigration = { file: string; prunedInto: string };

const isPruned = (migration: unknown): migration is PrunedMigration =>
  typeof migration === "object" && migration !== null && "prunedInto" in migration;

const prunedMigration = ({ file, prunedInto }: PrunedMigration) => ({
  up: async () => {
    throw new Error(
      `Tenora: this tenant never ran migration "${file}", and its file was pruned into the schema dump ${prunedInto}. ` +
        "Restore the file from version control, run migrate:tenants, then prune again."
    );
  },
  down: async () => {
    throw new Error(
      `Tenora: migration "${file}" was pruned into the schema dump ${prunedInto}, so it cannot be rolled back.`
    );
  },
});

/**
 * Lists the migrations the dump contains alongside the files on disk, so tenants keep migrating after
 * `--prune` deleted those files. Knex would otherwise call the migrations directory corrupt.
 */
export const withSchemaDumpMigrations = (
  migrations: Knex.MigratorConfig,
  dump: SchemaDump
): Knex.MigratorConfig => {
  if (migrations.migrationSource || !migrations.directory) return migrations;
  // Knex replaces a migrationSource with its own whenever these file options are set too.
  const { directory, sortDirsSeparately, loadExtensions, ...rest } = migrations;
  const FsMigrations = loadFsMigrations();
  const onDisk = new FsMigrations(directory, sortDirsSeparately, loadExtensions);

  const migrationSource: MigrationSource = {
    getMigrations: async (defaultExtensions) => {
      const files = await onDisk.getMigrations(loadExtensions ?? defaultExtensions);
      const present = new Set(files.map((file) => onDisk.getMigrationName(file)));
      const pruned: PrunedMigration[] = dump.migrations
        .filter((name) => !present.has(name))
        .map((file) => ({ file, prunedInto: dump.file }));
      return [...pruned, ...files];
    },
    getMigrationName: (migration) =>
      isPruned(migration) ? migration.file : onDisk.getMigrationName(migration),
    getMigration: async (migration) =>
      isPruned(migration) ? prunedMigration(migration) : onDisk.getMigration(migration),
  };
  return { ...rest, migrationSource };
};

const listMigrationFiles = async (migrations: Knex.MigratorConfig) => {
  const FsMigrations = loadFsMigrations();
  const onDisk = new FsMigrations(
    migrationDirectories(migrations),
    migrations.sortDirsSeparately,
    migrations.loadExtensions
  );
  // Undefined falls back to Knex's default extensions inside FsMigrations.
  const files = (await onDisk.getMigrations(migrations.loadExtensions as readonly string[])) as {
    file: string;
    directory: string;
  }[];
  return files;
};

/** Deletes the migration files whose names the dump contains, and returns their paths. */
export const pruneMigrationFiles = async (
  migrations: Knex.MigratorConfig,
  dumped: string[]
): Promise<string[]> => {
  const names = new Set(dumped);
  const pruned: string[] = [];
  for (const { file, directory } of await listMigrationFiles(migrations)) {
    if (!names.has(file)) continue;
    const filePath = path.join(directory, file);
    fs.rmSync(filePath);
    pruned.push(filePath);
  }
  return pruned;
};

/** Compares the migration files on disk with the dump, without touching a database. */
export const checkTenantSchemaDump = async (
  options: MultiTenantOptions
): Promise<SchemaDumpStatus> => {
  const file = resolveSchemaFile(options);
  const migrations = resolveTenantMigrations(options);
  if (!file || !migrations?.directory) {
    throw new Error(
      "Tenora: schema dumps need tenant.migrationsDir, a client other than SQL Server, and tenant.schemaFile not set to false."
    );
  }
  const dump = readSchemaDump(file);
  const contained = new Set(dump?.migrations ?? []);
  const missing = (await listMigrationFiles(migrations))
    .map(({ file: name }) => name)
    .filter((name) => !contained.has(name));
  return { file, exists: Boolean(dump), missing };
};
