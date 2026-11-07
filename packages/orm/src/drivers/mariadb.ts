import type { DatabaseErrorKind } from "../errors";
import { requireDriver } from "./resolve";
import { DEFAULT_POOL, type DriverConnection, type DriverPool, type PoolOptions } from "./types";

type OkPacket = { affectedRows?: number; insertId?: number | bigint };
type MariadbConnection = {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
  release(): Promise<void>;
  destroy(): void;
};
type MariadbPool = { getConnection(): Promise<MariadbConnection>; end(): Promise<void> };
type MariadbModule = { createPool(config: Record<string, unknown>): MariadbPool };

const ERRNO_KINDS: Record<number, DatabaseErrorKind> = {
  1062: "unique_violation",
  1451: "foreign_key_violation",
  1452: "foreign_key_violation",
  1048: "not_null_violation",
  1213: "deadlock",
  1205: "lock_timeout",
};

const CODE_KINDS: Record<string, DatabaseErrorKind> = {
  ER_SOCKET_UNEXPECTED_CLOSE: "connection_lost",
  ER_CONNECTION_ALREADY_CLOSED: "connection_lost",
  ECONNRESET: "connection_lost",
  EPIPE: "connection_lost",
};

const classify = (error: unknown): DatabaseErrorKind | undefined => {
  const { errno, code } = (error ?? {}) as { errno?: number; code?: string };
  return (errno !== undefined ? ERRNO_KINDS[errno] : undefined) ?? (code ? CODE_KINDS[code] : undefined);
};

export const createMariadbPool = (connection: Record<string, unknown>, options: PoolOptions = {}): DriverPool => {
  let pool: MariadbPool | undefined;
  const connections = new WeakMap<DriverConnection, MariadbConnection>();

  const getPool = () => {
    if (!pool) {
      const mariadb = requireDriver<MariadbModule>("mariadb");
      pool = mariadb.createPool({
        ...connection,
        multipleStatements: false,
        connectionLimit: options.max ?? DEFAULT_POOL.max,
        minimumIdle: options.min ?? DEFAULT_POOL.min,
        // The mariadb driver counts this one in seconds.
        idleTimeout: Math.ceil((options.idleTimeoutMillis ?? DEFAULT_POOL.idleTimeoutMillis) / 1000),
        acquireTimeout: options.acquireTimeoutMillis ?? DEFAULT_POOL.acquireTimeoutMillis,
        // Numbers as mysql2 returns them: ids and BIGINT counts as numbers, DECIMAL as exact strings.
        insertIdAsNumber: true,
        bigIntAsNumber: true,
        decimalAsNumber: false,
      });
    }
    return pool;
  };

  return {
    driver: "mariadb",
    classify,
    async acquire() {
      const raw = await getPool().getConnection();
      const wrapped: DriverConnection = {
        async query(sql, parameters) {
          const result = await raw.query(sql, parameters);
          if (Array.isArray(result)) {
            // Rows carry a non-enumerable `meta`; spreading them leaves only the columns.
            const rows = result.map((row) => ({ ...(row as Record<string, unknown>) }));
            return { rows, affectedRows: rows.length };
          }
          const packet = (result ?? {}) as OkPacket;
          return { rows: [], affectedRows: packet.affectedRows ?? 0, insertId: packet.insertId };
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
      else await raw.release();
    },
    async destroy() {
      const current = pool;
      pool = undefined;
      await current?.end();
    },
  };
};
