import { type Connection, sql } from "@tenora/orm";
import type { TenoraClient } from "../types";

export const resolveClient = (value?: TenoraClient): TenoraClient => value ?? "pg";

export const isPostgresClient = (client: TenoraClient): boolean =>
  client === "pg" || client === "postgres" || client === "postgresql";

export const isMysqlClient = (client: TenoraClient): boolean =>
  client === "mysql" || client === "mysql2" || client === "mariadb";

// 0.x's "sqlite3" counts, so a config that still names it reaches the ORM, which explains that it is gone.
export const isSqliteClient = (client: TenoraClient | "sqlite3"): boolean =>
  client === "better-sqlite3" || client === "sqlite" || client === "sqlite3";

export const isMssqlClient = (client: TenoraClient): boolean =>
  client === "mssql" || client === "sqlserver" || client === "tedious";

export const normalizePassword = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return String(value);
};

export const escapePgIdent = (value: string) => value.replace(/"/g, "\"\"");
export const escapeMysqlIdent = (value: string) => value.replace(/`/g, "``");
export const escapeMssqlIdent = (value: string) => value.replace(/]/g, "]]");
export const escapeSqlString = (value: string) => value.replace(/'/g, "''");

/** Runs a statement Tenora wrote itself, with its identifiers and strings already escaped. */
export const runText = (db: Connection, text: string) => db.raw(sql`${sql.raw(text)}`);
