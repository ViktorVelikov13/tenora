import type { DatabaseErrorKind } from "../errors";
import { requireDriver } from "./resolve";
import { DEFAULT_POOL, type DriverConnection, type DriverPool, type PoolOptions } from "./types";

type ResultHeader = { affectedRows?: number; insertId?: number | string };
type MysqlConnection = {
  query(options: { sql: string; values: readonly unknown[] }): Promise<[unknown, unknown]>;
  release(): void;
  destroy(): void;
};
type MysqlPool = { getConnection(): Promise<MysqlConnection>; end(): Promise<void> };
type MysqlModule = { createPool(config: Record<string, unknown>): MysqlPool };

const ERRNO_KINDS: Record<number, DatabaseErrorKind> = {
  1062: "unique_violation",
  1451: "foreign_key_violation",
  1452: "foreign_key_violation",
  1048: "not_null_violation",
  1213: "deadlock",
  1205: "lock_timeout",
  2006: "connection_lost",
  2013: "connection_lost",
};

const CODE_KINDS: Record<string, DatabaseErrorKind> = {
  PROTOCOL_CONNECTION_LOST: "connection_lost",
  ECONNRESET: "connection_lost",
  EPIPE: "connection_lost",
};

const classify = (error: unknown): DatabaseErrorKind | undefined => {
  const { errno, code } = (error ?? {}) as { errno?: number; code?: string };
  return (errno !== undefined ? ERRNO_KINDS[errno] : undefined) ?? (code ? CODE_KINDS[code] : undefined);
};

export const createMysql2Pool = (connection: Record<string, unknown>, options: PoolOptions = {}): DriverPool => {
  let pool: MysqlPool | undefined;
  const connections = new WeakMap<DriverConnection, MysqlConnection>();

  const getPool = () => {
    if (!pool) {
      const mysql = requireDriver<MysqlModule>("mysql2/promise", "mysql2");
      pool = mysql.createPool({
        ...connection,
        // Never several statements in one query: that is how SQL injection gets a second statement in.
        multipleStatements: false,
        waitForConnections: true,
        connectionLimit: options.max ?? DEFAULT_POOL.max,
        maxIdle: options.min ?? DEFAULT_POOL.min,
        idleTimeout: options.idleTimeoutMillis ?? DEFAULT_POOL.idleTimeoutMillis,
      });
    }
    return pool;
  };

  // mysql2 waits for a free connection without a limit, so the wait is timed here.
  const acquireTimeout = options.acquireTimeoutMillis ?? DEFAULT_POOL.acquireTimeoutMillis;
  const getConnection = async () => {
    const pending = getPool().getConnection();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // A connection that arrives after giving up goes straight back to the pool.
        pending.then((late) => late.release(), () => undefined);
        reject(
          new Error(
            `Tenora: waited ${acquireTimeout} ms for a free MySQL connection; every connection in the pool is in use.`
          )
        );
      }, acquireTimeout);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    driver: "mysql2",
    classify,
    async acquire() {
      const raw = await getConnection();
      const wrapped: DriverConnection = {
        async query(sql, parameters) {
          // query(), not execute(): the values are escaped by the driver, as Knex does, and no statement cache grows.
          const [result] = await raw.query({ sql, values: parameters });
          if (Array.isArray(result)) {
            return { rows: result as Record<string, unknown>[], affectedRows: result.length };
          }
          const header = (result ?? {}) as ResultHeader;
          return { rows: [], affectedRows: header.affectedRows ?? 0, insertId: header.insertId };
        },
      };
      connections.set(wrapped, raw);
      return wrapped;
    },
    async release(wrapped, broken = false) {
      const raw = connections.get(wrapped);
      connections.delete(wrapped);
      if (!raw) return;
      if (broken) raw.destroy();
      else raw.release();
    },
    async destroy() {
      const current = pool;
      pool = undefined;
      await current?.end();
    },
  };
};
