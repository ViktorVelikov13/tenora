import type { Connection } from "../connection";
import type { Dialect } from "../dialect";
import { QueryError } from "../errors";
import { type RawSql, sql } from "../sql";

/** The rows of the bookkeeping table, as every driver returns them. */
export type MigrationRow = {
  id: number;
  name: string;
  batch: number;
  migrated_at: unknown;
  source: string;
};

/** Where DDL runs inside a transaction and rolls back with it. MySQL and MariaDB commit it as they run it. */
export const transactionalDdl = (dialect: Dialect): boolean => dialect !== "mysql" && dialect !== "mariadb";

const ref = sql.ref;

// Column types per dialect. migrated_at gets a JavaScript Date on insert, which each driver encodes: SQLite stores
// milliseconds since the epoch, as Knex did.
const TYPES: Record<Dialect, { id: string; text: (length: number) => string; int: string; time: string }> = {
  postgres: { id: "serial primary key", text: (n) => `varchar(${n})`, int: "integer", time: "timestamptz" },
  mysql: { id: "int unsigned not null auto_increment primary key", text: (n) => `varchar(${n})`, int: "int", time: "datetime(3)" },
  mariadb: { id: "int unsigned not null auto_increment primary key", text: (n) => `varchar(${n})`, int: "int", time: "datetime(3)" },
  sqlite: { id: "integer primary key autoincrement", text: (n) => `varchar(${n})`, int: "integer", time: "datetime" },
  mssql: { id: "int identity(1,1) not null primary key", text: (n) => `nvarchar(${n})`, int: "int", time: "datetime2" },
};

/** CREATE TABLE unless the table exists; SQL Server has no IF NOT EXISTS, so it asks object_id(). */
const createUnlessExists = (dialect: Dialect, table: string, columns: RawSql): RawSql =>
  dialect === "mssql"
    ? sql`if object_id(${table}, N'U') is null create table ${ref(table)} (${columns})`
    : sql`create table if not exists ${ref(table)} (${columns})`;

const migrationsTable = (dialect: Dialect, table: string): RawSql => {
  const t = TYPES[dialect];
  return createUnlessExists(
    dialect,
    table,
    sql`${ref("id")} ${sql.raw(t.id)}, ${ref("name")} ${sql.raw(t.text(255))} not null, ${ref("batch")} ${sql.raw(t.int)} not null, ${ref("migrated_at")} ${sql.raw(t.time)} not null, ${ref("source")} ${sql.raw(t.text(32))} not null`
  );
};

const lockTable = (dialect: Dialect, table: string): RawSql => {
  const t = TYPES[dialect];
  return createUnlessExists(
    dialect,
    table,
    sql`${ref("id")} ${sql.raw(t.int)} not null primary key, ${ref("is_locked")} ${sql.raw(t.int)} not null default 0`
  );
};

// Two migrators creating the tables at the same moment can collide even with IF NOT EXISTS (Postgres reports a
// duplicate type, SQL Server an existing object). By the time the loser fails the winner's table exists, so one more
// try succeeds.
const create = (db: Connection, statement: RawSql) => db.raw(statement).catch(() => db.raw(statement));

/**
 * Creates the bookkeeping table and its lock table, unless they exist, with plain DDL, and the lock table's single
 * row. The schema builder is not used, so the migrator does not depend on it.
 */
export const ensureTables = async (db: Connection, table: string, lock: string): Promise<void> => {
  await create(db, migrationsTable(db.dialect, table));
  await create(db, lockTable(db.dialect, lock));
  if ((await db.table(lock).count()) > 0) return;
  try {
    // A fixed key, so two first runs cannot leave two rows.
    await db.table(lock).insert({ id: 1, is_locked: 0 });
  } catch (error) {
    if (!(error instanceof QueryError && error.kind === "unique_violation")) throw error;
  }
};
