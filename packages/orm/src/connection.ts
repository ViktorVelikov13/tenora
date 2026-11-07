import { AsyncLocalStorage } from "node:async_hooks";
import { compileRaw, type CompiledQuery } from "./compile";
import { type Client, type Dialect, defaultDialect, resolveDriverName } from "./dialect";
import { createBetterSqlite3Pool } from "./drivers/betterSqlite3";
import { createMariadbPool } from "./drivers/mariadb";
import { createMysql2Pool } from "./drivers/mysql2";
import { createPgPool } from "./drivers/pg";
import { createTediousPool } from "./drivers/tedious";
import type { DriverPool, DriverResult, PoolOptions } from "./drivers/types";
import { isConcurrencyError, QueryError } from "./errors";
import { QueryBuilder } from "./query/builder";
import type { RawSql } from "./sql";
import { type Scope, TransactionRoot, type TransactionOptions } from "./transaction";

export type ConnectionConfig = {
  /** the driver: "pg", "mysql2", "mariadb", "better-sqlite3" or "mssql" (tedious); 0.x aliases such as "postgres" work too */
  client: Client;
  /** the SQL dialect, when the driver's default is not right, e.g. "mariadb" for a MariaDB server reached through mysql2 */
  dialect?: Dialect;
  /** passed to the driver as is: host, port, user, password, database, ssl, … or filename for SQLite */
  connection: Record<string, unknown>;
  pool?: PoolOptions;
};

/**
 * The context of the current async flow: the open transaction of each connection, and the innermost transaction
 * whose callback is running. Only `run()` is used, never `enterWith()`, and it is read only when user code starts a
 * query, never inside driver or pool callbacks.
 */
type Context = {
  readonly scopes: ReadonlyMap<Connection, Scope>;
  readonly current: Scope | undefined;
};

const storage = new AsyncLocalStorage<Context>();
const EMPTY: Context = { scopes: new Map(), current: undefined };
const currentContext = (): Context => storage.getStore() ?? EMPTY;

const enter = (context: Context, connection: Connection, scope: Scope): Context => ({
  scopes: new Map(context.scopes).set(connection, scope),
  current: scope,
});

const backoff = (attempt: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.round(Math.random() * 25 * attempt)));

const createPool = (config: ConnectionConfig): DriverPool => {
  const driver = resolveDriverName(config.client);
  switch (driver) {
    case "pg":
      return createPgPool(config.connection, config.pool);
    case "mysql2":
      return createMysql2Pool(config.connection, config.pool);
    case "mariadb":
      return createMariadbPool(config.connection, config.pool);
    case "better-sqlite3":
      return createBetterSqlite3Pool(config.connection, config.pool);
    case "tedious":
      return createTediousPool(config.connection, config.pool);
  }
};

/** A transaction started with `beginTransaction()`, for code that cannot use a callback. */
export class Transaction {
  /** @internal */
  constructor(
    readonly connection: Connection,
    /** @internal */ readonly root: TransactionRoot
  ) {}

  /** True until it commits or rolls back. */
  get isOpen() {
    return this.root.state === "open";
  }

  /** Runs `fn` with this transaction as the ambient one, so queries on its connection join it. */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    return Promise.resolve(storage.run(enter(currentContext(), this.connection, this.root.scope), fn));
  }

  afterCommit(callback: () => unknown) {
    this.root.scope.addCallback(callback);
  }

  async commit(): Promise<void> {
    try {
      await this.root.commit();
    } catch (error) {
      await this.root.rollback();
      await this.root.finish();
      throw error;
    }
    await this.root.finish();
    await this.root.runAfterCommit();
  }

  async rollback(): Promise<void> {
    await this.root.rollback();
    await this.root.finish();
  }
}

export class Connection {
  readonly dialect: Dialect;
  readonly #pool: DriverPool;

  constructor(config: ConnectionConfig) {
    this.#pool = createPool(config);
    this.dialect = config.dialect ?? defaultDialect(this.#pool.driver);
  }

  /** A query builder for one table. */
  table<Row extends Record<string, unknown> = Record<string, unknown>>(name: string): QueryBuilder<Row> {
    return QueryBuilder.forTable<Row>(this, name);
  }

  /** Runs a raw `sql` fragment and returns its rows. */
  raw<Row extends Record<string, unknown> = Record<string, unknown>>(fragment: RawSql): Promise<Row[]> {
    try {
      return this.execute(compileRaw(this.dialect, fragment)).then((result) => result.rows as Row[]);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Runs `fn` in a transaction. Every query on this connection inside it joins the transaction, with nothing passed
   * around. Called inside another transaction on this connection, it becomes a savepoint: its failure rolls back
   * only its own work. With `attempts`, the outermost transaction runs `fn` again after a deadlock or serialization
   * failure.
   */
  transaction<T>(fn: () => Promise<T> | T, options: TransactionOptions = {}): Promise<T> {
    const context = currentContext();
    const parent = context.scopes.get(this);
    // A parent that already ended rejects in #nested, like a query would, rather than starting an unrelated
    // transaction from work that outlived its own.
    return parent ? this.#nested(context, parent, fn) : this.#outermost(context, fn, options);
  }

  async #nested<T>(context: Context, parent: Scope, fn: () => Promise<T> | T): Promise<T> {
    // Siblings take turns, so their savepoints never interleave.
    const unlock = await parent.childLock.lock();
    try {
      const root = parent.root;
      const scope = await root.beginNested(parent);
      let result: T;
      try {
        result = await storage.run(enter(context, this, scope), fn);
      } catch (error) {
        await root.rollbackNested(scope);
        throw error;
      }
      await root.releaseNested(scope);
      return result;
    } finally {
      unlock();
    }
  }

  async #outermost<T>(context: Context, fn: () => Promise<T> | T, options: TransactionOptions): Promise<T> {
    const attempts = Math.max(1, Math.floor(options.attempts ?? 1));
    for (let attempt = 1; ; attempt++) {
      const root = await TransactionRoot.begin(this.dialect, this.#pool, options.isolation);
      let result: T;
      try {
        result = await storage.run(enter(context, this, root.scope), fn);
        await root.commit();
      } catch (error) {
        await root.rollback();
        await root.finish();
        const retryable = isConcurrencyError(error) || isConcurrencyError(root.abortReason);
        if (retryable && attempt < attempts) {
          await backoff(attempt);
          continue;
        }
        throw error;
      }
      await root.finish();
      await root.runAfterCommit();
      return result;
    }
  }

  /** Starts a transaction that the caller commits or rolls back. Until then it holds a connection from the pool. */
  async beginTransaction(options: Pick<TransactionOptions, "isolation"> = {}): Promise<Transaction> {
    const root = await TransactionRoot.begin(this.dialect, this.#pool, options.isolation);
    return new Transaction(this, root);
  }

  /**
   * Runs `callback` after the transaction open on this connection commits, or now if none is open. It is dropped
   * if the transaction rolls back.
   */
  afterCommit(callback: () => unknown): void | Promise<void> {
    const scope = currentContext().scopes.get(this);
    if (!scope) return Promise.resolve(callback()).then(() => undefined);
    scope.addCallback(callback);
  }

  /** Closes every pooled connection. */
  destroy(): Promise<void> {
    return this.#pool.destroy();
  }

  /**
   * @internal Runs a compiled query: in `explicit` when given, otherwise in the transaction open on this connection
   * in the current context, otherwise on a pooled connection. The context is read here, synchronously, in the
   * caller's async flow.
   */
  execute(compiled: CompiledQuery, explicit?: Transaction): Promise<DriverResult> {
    if (explicit && explicit.connection !== this) {
      return Promise.reject(new Error("Tenora: that transaction belongs to a different connection."));
    }
    const scope = explicit ? explicit.root.scope : currentContext().scopes.get(this);
    if (scope) return scope.root.query(compiled.sql, compiled.parameters, scope);
    return this.#pooled(compiled);
  }

  async #pooled({ sql, parameters }: CompiledQuery): Promise<DriverResult> {
    const client = await this.#pool.acquire();
    let broken = false;
    try {
      return await client.query(sql, parameters);
    } catch (cause) {
      const kind = this.#pool.classify(cause);
      broken = kind === "connection_lost";
      throw new QueryError(cause, kind, sql, parameters);
    } finally {
      await this.#pool.release(client, broken);
    }
  }
}

export const createConnection = (config: ConnectionConfig): Connection => new Connection(config);

/**
 * Runs `callback` after the innermost transaction whose callback is running commits, or now if there is none. It is
 * dropped if that transaction rolls back.
 */
export const afterCommit = (callback: () => unknown): void | Promise<void> => {
  const scope = currentContext().current;
  if (!scope) return Promise.resolve(callback()).then(() => undefined);
  scope.addCallback(callback);
};

/** Runs `fn` outside every ambient transaction, for writes that must survive a rollback (audit logs, counters). */
export const withoutTransaction = <T>(fn: () => Promise<T> | T): Promise<T> =>
  Promise.resolve(storage.run(EMPTY, fn));
