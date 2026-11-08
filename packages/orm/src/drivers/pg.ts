import type { DatabaseErrorKind } from "../errors";
import { requireDriver } from "./resolve";
import { DEFAULT_POOL, type DriverConnection, type DriverPool, type PoolOptions } from "./types";

type PgResult = { rows?: Record<string, unknown>[]; rowCount?: number | null; command?: string };
type PgClient = {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
  release(destroy?: boolean): void;
};
type PgPool = {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): void;
};
type PgModule = { Pool: new (config: Record<string, unknown>) => PgPool };

const KINDS: Record<string, DatabaseErrorKind> = {
  "23505": "unique_violation",
  "23503": "foreign_key_violation",
  "23502": "not_null_violation",
  "40P01": "deadlock",
  "40001": "serialization_failure",
  "55P03": "lock_timeout",
  "57P01": "connection_lost",
  "57P02": "connection_lost",
  "57P03": "connection_lost",
  "08000": "connection_lost",
  "08003": "connection_lost",
  "08006": "connection_lost",
  ECONNRESET: "connection_lost",
  EPIPE: "connection_lost",
};

const classify = (error: unknown): DatabaseErrorKind | undefined => {
  const { code, message } = (error ?? {}) as { code?: string; message?: string };
  if (code && KINDS[code]) return KINDS[code];
  if (message && /Connection terminated|Client has encountered a connection error/i.test(message)) {
    return "connection_lost";
  }
  return undefined;
};

export const createPgPool = (connection: Record<string, unknown>, options: PoolOptions = {}): DriverPool => {
  let pool: PgPool | undefined;
  const clients = new WeakMap<DriverConnection, PgClient>();

  const getPool = () => {
    if (!pool) {
      const { Pool } = requireDriver<PgModule>("pg");
      pool = new Pool({
        ...connection,
        max: options.max ?? DEFAULT_POOL.max,
        min: options.min ?? DEFAULT_POOL.min,
        idleTimeoutMillis: options.idleTimeoutMillis ?? DEFAULT_POOL.idleTimeoutMillis,
        connectionTimeoutMillis: options.acquireTimeoutMillis ?? DEFAULT_POOL.acquireTimeoutMillis,
      });
      // An idle client that errors is removed by the pool; without a listener the error would crash the process.
      pool.on("error", () => {});
    }
    return pool;
  };

  return {
    driver: "pg",
    classify,
    async acquire() {
      const client = await getPool().connect();
      const wrapped: DriverConnection = {
        async query(sql, parameters) {
          const result = (await client.query(sql, parameters)) as PgResult;
          return { rows: result.rows ?? [], affectedRows: result.rowCount ?? 0, command: result.command };
        },
        async script(text) {
          // Without values, pg uses the simple protocol, which takes several statements.
          await client.query(text);
        },
      };
      clients.set(wrapped, client);
      return wrapped;
    },
    async release(wrapped, broken = false) {
      clients.get(wrapped)?.release(broken || undefined);
      clients.delete(wrapped);
    },
    async destroy() {
      const current = pool;
      pool = undefined;
      await current?.end();
    },
  };
};
