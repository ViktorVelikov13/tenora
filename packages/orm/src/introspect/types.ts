import type { Connection } from "../connection";
import type { Dialect } from "../dialect";

/** What a foreign key does when the referenced row is deleted or its key changes. */
export type ReferentialAction = "no action" | "restrict" | "cascade" | "set null" | "set default";

export type ColumnInfo = {
  name: string;
  /** The base type, lowercase and without arguments: "varchar", "integer", "decimal", "timestamptz", "nvarchar". */
  type: string;
  /** The full type as the database reports it: "character varying(255)", "int unsigned", "nvarchar(max)". */
  rawType: string;
  /** Characters (or bytes, for binary types) of a sized type such as varchar(255); null when unsized or unlimited. */
  length: number | null;
  /** Digits of a decimal, or fractional-second digits of a time type, when the type has them. */
  precision: number | null;
  /** Digits after the point of a decimal. */
  scale: number | null;
  nullable: boolean;
  /** The default expression as the database reports it, lightly normalized; null when there is none. */
  default: string | null;
  autoIncrement: boolean;
  /** Part of the primary key. */
  primaryKey: boolean;
};

export type IndexInfo = {
  name: string;
  /** In index order. An expression shows as its SQL text. */
  columns: string[];
  unique: boolean;
  /**
   * The condition of a partial (filtered) index, as the database reports it; absent for a full index. MySQL and
   * MariaDB have no partial indexes. Knex's unique() on SQL Server makes one: `[email] IS NOT NULL`.
   */
  where?: string;
  /**
   * SQL Server only: the server made up this name, with a random suffix, because the DDL gave none. Two such
   * names compare as equal.
   */
  systemNamed?: true;
};

export type ForeignKeyInfo = {
  /** null on SQLite when the constraint was declared without a name. */
  name: string | null;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
  /** As on IndexInfo: a name SQL Server generated. */
  systemNamed?: true;
};

export type CheckInfo = {
  /** null on SQLite when the constraint was declared without a name. */
  name: string | null;
  /** The condition as the database reports it, without CHECK and its parentheses. */
  expression: string;
  /** As on IndexInfo: a name SQL Server generated. */
  systemNamed?: true;
};

export type TableInfo = {
  name: string;
  /** In table order. */
  columns: ColumnInfo[];
  /** The primary key's columns in key order; empty when there is none. */
  primaryKey: string[];
  /** Every index but the primary key's, sorted by name. Unique constraints are listed as unique indexes. */
  indexes: IndexInfo[];
  /** Sorted by name, then columns. */
  foreignKeys: ForeignKeyInfo[];
  /**
   * Check constraints, sorted by name, then expression. Knex's enu() is one on Postgres and SQLite. Not listed:
   * Postgres's NOT NULL constraints, and the json_valid() check MariaDB adds to a json column.
   */
  checks: CheckInfo[];
};

export type SchemaInfo = {
  dialect: Dialect;
  /** Sorted by name. */
  tables: TableInfo[];
};

export type ListTablesOptions = {
  /**
   * Tables to leave out: exact names, patterns where `*` matches any run of characters, or regular expressions.
   * Names compare case-insensitively. `BOOKKEEPING_TABLES` lists Tenora's and Knex's migration tables.
   */
  exclude?: ReadonlyArray<string | RegExp>;
};

export type CompareOptions = {
  /** Match indexes, foreign keys and checks by what they cover instead of by name (default false: names matter). */
  ignoreNames?: boolean;
  /** How the two schemas are called in the messages (default ["a", "b"]). */
  labels?: readonly [string, string];
};

/**
 * @internal The catalog queries of one dialect. Everything is scoped to the connection's current schema
 * (Postgres, SQL Server) or database (MySQL, MariaDB), or to SQLite's main database.
 */
export interface Introspector {
  listTables(db: Connection): Promise<string[]>;
  /** Table names compare as the database compares them: exactly on Postgres, by collation elsewhere. */
  hasTable(db: Connection, table: string): Promise<boolean>;
  hasColumn(db: Connection, table: string, column: string): Promise<boolean>;
  /** undefined when there is no such table. */
  describeTable(db: Connection, table: string): Promise<TableInfo | undefined>;
}

/** The bookkeeping tables of Tenora's and Knex's migrators, for `exclude`. */
export const BOOKKEEPING_TABLES: readonly string[] = Object.freeze(["tenora_migrations*", "knex_migrations*"]);
