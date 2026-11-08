import type { DatabaseErrorKind } from "../errors";
import { requireDriver } from "./resolve";
import { DEFAULT_POOL, type DriverConnection, type DriverPool, type PoolOptions } from "./types";

type Statement = {
  reader: boolean;
  all(...values: unknown[]): Record<string, unknown>[];
  run(...values: unknown[]): { changes: number; lastInsertRowid: number | bigint };
};
type Database = { prepare(sql: string): Statement; exec(sql: string): unknown; close(): void };
type DatabaseConstructor = new (filename: string, options?: Record<string, unknown>) => Database;

const classify = (error: unknown): DatabaseErrorKind | undefined => {
  const code = (error as { code?: string })?.code ?? "";
  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return "unique_violation";
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return "foreign_key_violation";
  if (code === "SQLITE_CONSTRAINT_NOTNULL") return "not_null_violation";
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return "busy";
  return undefined;
};

// SQLite has no boolean or date types. Booleans are stored as 1/0 and dates as milliseconds since the epoch, which is
// what Knex stored, so databases written by Tenora 0.x read the same.
const encode = (value: unknown) =>
  typeof value === "boolean" ? (value ? 1 : 0) : value instanceof Date ? value.getTime() : value;

/**
 * SQLite gets one connection. Queries take turns on it, and an open transaction holds it until it ends, so a query
 * outside that transaction waits for it.
 */
export const createBetterSqlite3Pool = (connection: Record<string, unknown>, options: PoolOptions = {}): DriverPool => {
  const { filename, ...databaseOptions } = connection as { filename?: string } & Record<string, unknown>;
  if (typeof filename !== "string") {
    throw new Error("Tenora: SQLite needs connection.filename (a file path or \":memory:\").");
  }
  const acquireTimeout = options.acquireTimeoutMillis ?? DEFAULT_POOL.acquireTimeoutMillis;
  let database: Database | undefined;
  let held = false;
  const waiting: Array<() => void> = [];

  const wrapped: DriverConnection = {
    async query(sql, parameters) {
      const statement = database!.prepare(sql);
      const values = parameters.map(encode);
      if (statement.reader) {
        const rows = statement.all(...values);
        return { rows, affectedRows: rows.length };
      }
      const info = statement.run(...values);
      return { rows: [], affectedRows: info.changes, insertId: info.lastInsertRowid };
    },
    async script(text) {
      database!.exec(text);
    },
  };

  return {
    driver: "better-sqlite3",
    classify,
    async acquire() {
      if (held) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiting.splice(waiting.indexOf(grant), 1);
            reject(
              new Error(
                `Tenora: waited ${acquireTimeout} ms for the SQLite connection. SQLite has one connection, and an open transaction holds it until the transaction ends.`
              )
            );
          }, acquireTimeout);
          const grant = () => {
            clearTimeout(timer);
            resolve();
          };
          waiting.push(grant);
        });
      }
      held = true;
      if (!database) {
        const Sqlite = requireDriver<DatabaseConstructor>("better-sqlite3");
        database = new Sqlite(filename, databaseOptions);
      }
      return wrapped;
    },
    async release() {
      const next = waiting.shift();
      if (next) next();
      else held = false;
    },
    async destroy() {
      database?.close();
      database = undefined;
    },
  };
};
