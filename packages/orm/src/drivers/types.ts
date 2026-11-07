import type { Driver } from "../dialect";
import type { DatabaseErrorKind } from "../errors";

export type DriverResult = {
  rows: Record<string, unknown>[];
  affectedRows: number;
  insertId?: number | bigint | string;
  /** The command tag Postgres reports, e.g. "COMMIT", or "ROLLBACK" when a COMMIT did not commit. */
  command?: string;
};

/** One physical connection, taken from the pool. */
export interface DriverConnection {
  query(sql: string, parameters: readonly unknown[]): Promise<DriverResult>;
}

export type PoolOptions = {
  /** most connections at once (default 10; always 1 for SQLite) */
  max?: number;
  /** connections kept open while idle (default 0) */
  min?: number;
  /** close a connection idle for this long (default 60 s) */
  idleTimeoutMillis?: number;
  /** fail when no connection is free for this long, or connecting takes this long (default 60 s) */
  acquireTimeoutMillis?: number;
};

export interface DriverPool {
  readonly driver: Driver;
  acquire(): Promise<DriverConnection>;
  /** `broken` closes the connection instead of returning it to the pool. */
  release(connection: DriverConnection, broken?: boolean): Promise<void>;
  destroy(): Promise<void>;
  classify(error: unknown): DatabaseErrorKind | undefined;
}

export const DEFAULT_POOL = {
  max: 10,
  min: 0,
  idleTimeoutMillis: 60_000,
  acquireTimeoutMillis: 60_000,
} satisfies Required<PoolOptions>;
