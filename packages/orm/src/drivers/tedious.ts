import type { DatabaseErrorKind } from "../errors";
import { ResourcePool } from "./pool";
import { requireDriver } from "./resolve";
import type { DriverConnection, DriverPool, PoolOptions } from "./types";

type Column = { value: unknown; metadata: { colName: string } };
type TediousRequest = {
  addParameter(name: string, type: unknown, value: unknown): void;
  on(event: "row", listener: (columns: Column[]) => void): void;
};
type TediousConnection = {
  connect(callback: (error?: Error) => void): void;
  execSql(request: TediousRequest): void;
  execSqlBatch(request: TediousRequest): void;
  close(): void;
  on(event: "error" | "end", listener: (error?: Error) => void): void;
};
type TediousModule = {
  Connection: new (config: Record<string, unknown>) => TediousConnection;
  Request: new (sql: string, callback: (error: Error | null | undefined, rowCount?: number) => void) => TediousRequest;
  TYPES: Record<"NVarChar" | "Int" | "BigInt" | "Float" | "Bit" | "DateTime2" | "VarBinary", unknown>;
};

type Pooled = { connection: TediousConnection; dead: boolean };

const NUMBER_KINDS: Record<number, DatabaseErrorKind> = {
  2627: "unique_violation",
  2601: "unique_violation",
  515: "not_null_violation",
  1205: "deadlock",
  1222: "lock_timeout",
  3960: "serialization_failure",
};

const CODE_KINDS: Record<string, DatabaseErrorKind> = {
  ESOCKET: "connection_lost",
  ECLOSE: "connection_lost",
  ECONNRESET: "connection_lost",
  // A request that hit tedious's requestTimeout was cancelled mid-flight; the connection is closed, not reused, and a
  // timed-out COMMIT has an unknown outcome.
  ETIMEOUT: "connection_lost",
};

const classify = (error: unknown): DatabaseErrorKind | undefined => {
  const { number, code, message } = (error ?? {}) as { number?: number; code?: string; message?: string };
  // 547 covers both foreign key and check constraints.
  if (number === 547 && message?.includes("FOREIGN KEY")) return "foreign_key_violation";
  return (number !== undefined ? NUMBER_KINDS[number] : undefined) ?? (code ? CODE_KINDS[code] : undefined);
};

/**
 * Accepts the shape 0.x configs use for SQL Server (the `mssql` package's: server, port, user, password, database,
 * options) as well as tedious's own `authentication` object.
 */
const toTediousConfig = (connection: Record<string, unknown>) => {
  const {
    server,
    host,
    port,
    user,
    password,
    database,
    authentication,
    connectionTimeout,
    requestTimeout,
    options = {},
  } = connection as Record<string, any>;
  return {
    server: server ?? host,
    authentication: authentication ?? { type: "default", options: { userName: user, password } },
    options: {
      ...(port !== undefined ? { port: Number(port) } : {}),
      ...(database !== undefined ? { database } : {}),
      ...(connectionTimeout !== undefined ? { connectTimeout: connectionTimeout } : {}),
      ...(requestTimeout !== undefined ? { requestTimeout } : {}),
      ...options,
    },
  };
};

/** The SQL Server type for a parameter, inferred from its JavaScript value as Kysely's driver does. */
const parameterType = (TYPES: TediousModule["TYPES"], value: unknown) => {
  if (typeof value === "bigint") return TYPES.BigInt;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return TYPES.Float;
    return value > 2_147_483_647 || value < -2_147_483_648 ? TYPES.BigInt : TYPES.Int;
  }
  if (typeof value === "boolean") return TYPES.Bit;
  if (value instanceof Date) return TYPES.DateTime2;
  if (Buffer.isBuffer(value)) return TYPES.VarBinary;
  return TYPES.NVarChar;
};

/**
 * SQL Server through tedious, which allows one request at a time per connection (the transaction queue and the pool
 * guarantee that) and has no pool of its own. Statements without parameters run as plain batches: run through
 * sp_executesql, SET TRANSACTION ISOLATION LEVEL would be undone when it returns and BEGIN TRANSACTION would fail its
 * transaction count check.
 */
export const createTediousPool = (connection: Record<string, unknown>, options: PoolOptions = {}): DriverPool => {
  let tedious: TediousModule | undefined;
  const load = () => (tedious ??= requireDriver<TediousModule>("tedious"));
  const pooled = new WeakMap<DriverConnection, Pooled>();

  const resources = new ResourcePool<Pooled>(
    {
      create: () =>
        new Promise<Pooled>((resolve, reject) => {
          const raw = new (load().Connection)(toTediousConfig(connection));
          const entry: Pooled = { connection: raw, dead: false };
          raw.on("end", () => (entry.dead = true));
          // Socket errors are reported here once connected; without a listener they would crash the process.
          raw.on("error", () => (entry.dead = true));
          raw.connect((error) => (error ? reject(error) : resolve(entry)));
        }),
      destroy: async (entry) => entry.connection.close(),
      isUsable: (entry) => !entry.dead,
    },
    options
  );

  const query = (entry: Pooled, sql: string, parameters: readonly unknown[]) =>
    new Promise<{ rows: Record<string, unknown>[]; affectedRows: number }>((resolve, reject) => {
      const { Request, TYPES } = load();
      const rows: Record<string, unknown>[] = [];
      const request = new Request(sql, (error, rowCount) =>
        error ? reject(error) : resolve({ rows, affectedRows: rowCount ?? rows.length })
      );
      request.on("row", (columns) => {
        const row: Record<string, unknown> = {};
        for (const column of columns) row[column.metadata.colName] = column.value;
        rows.push(row);
      });
      if (parameters.length) {
        // Kysely numbers SQL Server parameters @1, @2, …
        parameters.forEach((value, index) =>
          request.addParameter(String(index + 1), parameterType(TYPES, value), value ?? null)
        );
        entry.connection.execSql(request);
      } else {
        entry.connection.execSqlBatch(request);
      }
    });

  return {
    driver: "tedious",
    classify,
    async acquire() {
      const entry = await resources.acquire();
      const wrapped: DriverConnection = {
        query: (sql, parameters) => query(entry, sql, parameters),
        // A statement without parameters goes as a batch, which takes several statements.
        script: async (text) => void (await query(entry, text, [])),
      };
      pooled.set(wrapped, entry);
      return wrapped;
    },
    async release(wrapped, broken = false) {
      const entry = pooled.get(wrapped);
      pooled.delete(wrapped);
      if (entry) await resources.release(entry, broken);
    },
    destroy: () => resources.destroy(),
  };
};
