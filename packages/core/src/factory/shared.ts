import type { TenoraClient } from "../types";

export const resolveClient = (value?: TenoraClient): TenoraClient => value ?? "pg";

export const isPostgresClient = (client: TenoraClient): boolean =>
  client === "pg" || client === "postgres" || client === "postgresql";

export const isMysqlClient = (client: TenoraClient): boolean =>
  client === "mysql" || client === "mysql2" || client === "mariadb";

export const isSqliteClient = (client: TenoraClient): boolean =>
  client === "sqlite3" || client === "better-sqlite3" || client === "sqlite";

export const isMssqlClient = (client: TenoraClient): boolean =>
  client === "mssql" || client === "sqlserver";

export const normalizePassword = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return String(value);
};

export const escapePgIdent = (value: string) => value.replace(/"/g, "\"\"");
export const escapeMysqlIdent = (value: string) => value.replace(/`/g, "``");
export const escapeMssqlIdent = (value: string) => value.replace(/]/g, "]]");
export const escapeSqlString = (value: string) => value.replace(/'/g, "''");
