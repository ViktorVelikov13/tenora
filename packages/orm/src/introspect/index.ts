import type { Connection } from "../connection";
import type { Dialect } from "../dialect";
import { mssql } from "./mssql";
import { mysql } from "./mysql";
import { compareText, excluder } from "./normalize";
import { postgres } from "./postgres";
import { sqlite } from "./sqlite";
import type { Introspector, ListTablesOptions, SchemaInfo, TableInfo } from "./types";

export { compareSchemas } from "./compare";
export {
  BOOKKEEPING_TABLES,
  type CheckInfo,
  type ColumnInfo,
  type CompareOptions,
  type ForeignKeyInfo,
  type IndexInfo,
  type ListTablesOptions,
  type ReferentialAction,
  type SchemaInfo,
  type TableInfo,
} from "./types";

const INTROSPECTORS: Record<Dialect, Introspector> = {
  postgres,
  mysql,
  mariadb: mysql,
  sqlite,
  mssql,
};

const introspector = (db: Connection) => INTROSPECTORS[db.dialect];

/** Whether the table exists in the connection's current schema (or database). */
export const hasTable = (db: Connection, table: string): Promise<boolean> => introspector(db).hasTable(db, table);

/**
 * Whether the table has the column. Postgres compares names exactly; MySQL, MariaDB and SQLite ignore case, and SQL
 * Server follows the database's collation.
 */
export const hasColumn = (db: Connection, table: string, column: string): Promise<boolean> =>
  introspector(db).hasColumn(db, table, column);

/** The tables of the connection's current schema (or database), sorted by name, without views. */
export const listTables = async (db: Connection, options: ListTablesOptions = {}): Promise<string[]> => {
  const excluded = excluder(options.exclude);
  const names = await introspector(db).listTables(db);
  return names.filter((name) => !excluded(name)).sort(compareText);
};

/** A table's columns, primary key, indexes and foreign keys, read from the database catalog. */
export const describeTable = async (db: Connection, table: string): Promise<TableInfo> => {
  const info = await introspector(db).describeTable(db, table);
  if (!info) throw new Error(`Tenora: there is no table "${table}" in the current ${db.dialect} schema.`);
  return info;
};

/** Every table of the connection's current schema (or database), described. */
export const describeSchema = async (db: Connection, options: ListTablesOptions = {}): Promise<SchemaInfo> => {
  const tables: TableInfo[] = [];
  // One table at a time: a schema can have hundreds, and a transaction runs its queries one by one anyway.
  for (const name of await listTables(db, options)) tables.push(await describeTable(db, name));
  return { dialect: db.dialect, tables };
};
