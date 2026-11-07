export type Dialect = "postgres" | "mysql" | "mariadb" | "sqlite" | "mssql";

/** Driver names accepted in `client`, with the 0.x aliases. */
export type Client =
  | "pg"
  | "postgres"
  | "postgresql"
  | "mysql"
  | "mysql2"
  | "mariadb"
  | "sqlite"
  | "better-sqlite3"
  | "mssql"
  | "sqlserver"
  | "tedious";

export type Driver = "pg" | "mysql2" | "mariadb" | "better-sqlite3" | "tedious";

export const resolveDriverName = (client: Client | "sqlite3" | (string & {})): Driver => {
  switch (client) {
    case "pg":
    case "postgres":
    case "postgresql":
      return "pg";
    case "mysql":
    case "mysql2":
      return "mysql2";
    case "mariadb":
      return "mariadb";
    case "mssql":
    case "sqlserver":
    case "tedious":
      return "tedious";
    case "sqlite":
    case "better-sqlite3":
      return "better-sqlite3";
    case "sqlite3":
      throw new Error(
        'Tenora: the "sqlite3" driver is no longer supported (it is deprecated and unmaintained). Install "better-sqlite3" and set client: "better-sqlite3"; the database files stay the same.'
      );
    default:
      throw new Error(`Tenora: unknown client "${client}".`);
  }
};

const DEFAULT_DIALECT: Record<Driver, Dialect> = {
  pg: "postgres",
  mysql2: "mysql",
  mariadb: "mariadb",
  "better-sqlite3": "sqlite",
  tedious: "mssql",
};

export const defaultDialect = (driver: Driver): Dialect => DEFAULT_DIALECT[driver];

/** RETURNING (or SQL Server's OUTPUT) on INSERT; MySQL has neither and reports the insert id instead. */
export const supportsReturning = (dialect: Dialect): boolean => dialect !== "mysql";

/** SAVEPOINT release; SQL Server has no RELEASE SAVEPOINT. */
export const supportsReleaseSavepoint = (dialect: Dialect): boolean => dialect !== "mssql";
