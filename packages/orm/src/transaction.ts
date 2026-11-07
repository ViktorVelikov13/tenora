import { type Dialect, supportsReleaseSavepoint } from "./dialect";
import type { DriverConnection, DriverPool, DriverResult } from "./drivers/types";
import {
  AfterCommitError,
  ConcurrentTransactionError,
  QueryError,
  TransactionAbortedError,
  TransactionClosedError,
  TransactionOutcomeUnknownError,
} from "./errors";

export type IsolationLevel = "read uncommitted" | "read committed" | "repeatable read" | "serializable";

const ISOLATION_LEVELS: readonly IsolationLevel[] = [
  "read uncommitted",
  "read committed",
  "repeatable read",
  "serializable",
];

export type TransactionOptions = {
  /** run the whole callback again after a deadlock or serialization failure, up to this many times in all (default 1) */
  attempts?: number;
  isolation?: IsolationLevel;
};

type State =
  | "open"
  // the database already rolled it back (a deadlock), or the connection broke; it can only be rolled back now
  | "aborted"
  | "rolling_back"
  | "committing"
  | "committed"
  | "rolled_back"
  // the connection was lost during COMMIT
  | "unknown";

/** Serializes callers: sibling nested transactions take turns. */
class Mutex {
  #tail: Promise<void> = Promise.resolve();

  lock(): Promise<() => void> {
    let unlock!: () => void;
    const released = new Promise<void>((resolve) => (unlock = resolve));
    const previous = this.#tail;
    this.#tail = previous.then(() => released);
    return previous.then(() => unlock);
  }
}

/** One level of a transaction: the transaction itself, or a savepoint inside it. */
export class Scope {
  readonly childLock = new Mutex();
  readonly callbacks: Array<() => unknown> = [];
  closed = false;

  constructor(
    readonly root: TransactionRoot,
    readonly parent: Scope | undefined,
    readonly level: number
  ) {}

  get savepoint() {
    return `tenora_sp_${this.level}`;
  }

  addCallback(callback: () => unknown) {
    if (this.closed || this.root.state !== "open") {
      throw new TransactionClosedError("Tenora: afterCommit() was called after its transaction ended.");
    }
    this.callbacks.push(callback);
  }
}

const beginStatements = (dialect: Dialect, isolation: IsolationLevel | undefined): string[] => {
  if (isolation && !ISOLATION_LEVELS.includes(isolation)) {
    throw new Error(`Tenora: unknown isolation level "${isolation}".`);
  }
  switch (dialect) {
    case "postgres":
      return [isolation ? `begin isolation level ${isolation}` : "begin"];
    case "mysql":
    case "mariadb":
      return isolation
        ? [`set transaction isolation level ${isolation}`, "start transaction"]
        : ["start transaction"];
    case "sqlite":
      // SQLite transactions are always serializable.
      return ["begin"];
    case "mssql":
      throw new Error("Tenora: transactions on SQL Server are not implemented yet.");
  }
};

/**
 * A transaction on one physical connection, taken from the pool for its whole life. Every statement goes through one
 * queue, in the order it was issued, so `Promise.all` inside a transaction is safe on every driver; once the
 * transaction ends, the queue rejects instead of falling back to the pool.
 */
export class TransactionRoot {
  state: State = "open";
  /** Why the database aborted the transaction, kept so the outermost `transaction()` can decide to retry. */
  abortReason: unknown;
  readonly scope: Scope;
  active: Scope;
  #tail: Promise<unknown> = Promise.resolve();
  #broken = false;

  private constructor(
    readonly dialect: Dialect,
    readonly pool: DriverPool,
    readonly client: DriverConnection
  ) {
    this.scope = new Scope(this, undefined, 1);
    this.active = this.scope;
  }

  static async begin(dialect: Dialect, pool: DriverPool, isolation?: IsolationLevel): Promise<TransactionRoot> {
    const statements = beginStatements(dialect, isolation);
    const client = await pool.acquire();
    const root = new TransactionRoot(dialect, pool, client);
    try {
      for (const statement of statements) await root.#run(statement, []);
    } catch (error) {
      await pool.release(client, true);
      throw error;
    }
    return root;
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #run(sql: string, parameters: readonly unknown[]): Promise<DriverResult> {
    try {
      return await this.client.query(sql, parameters);
    } catch (cause) {
      const error = new QueryError(cause, this.pool.classify(cause), sql, parameters);
      // These end the transaction on the database side (MySQL rolls back the whole transaction on a deadlock), so
      // nothing more may run in it, or it would run outside any transaction.
      if (error.kind === "deadlock" || error.kind === "serialization_failure" || error.kind === "connection_lost") {
        this.state = "aborted";
        this.abortReason = error;
        if (error.kind === "connection_lost") this.#broken = true;
      }
      throw error;
    }
  }

  #assertUsable(scope: Scope) {
    if (this.state === "aborted") {
      throw new TransactionAbortedError(
        "Tenora: the database already rolled this transaction back, so this query was not run. The outermost transaction() rolls back, and retries if it was given attempts.",
        { cause: this.abortReason }
      );
    }
    if (this.state !== "open") {
      throw new TransactionClosedError(
        this.state === "rolling_back"
          ? "Tenora: this transaction is rolling back, so the query was not run."
          : "Tenora: this transaction already committed or rolled back, so the query was not run."
      );
    }
    if (scope.closed) {
      throw new TransactionClosedError(
        "Tenora: this nested transaction already ended, so the query was not run."
      );
    }
    if (scope !== this.active) {
      throw new ConcurrentTransactionError(
        "Tenora: a query from an outer transaction ran while a nested transaction was open. Await the nested transaction() before running more queries in the outer one."
      );
    }
  }

  query(sql: string, parameters: readonly unknown[], scope: Scope): Promise<DriverResult> {
    return this.#enqueue(async () => {
      this.#assertUsable(scope);
      return this.#run(sql, parameters);
    });
  }

  beginNested(parent: Scope): Promise<Scope> {
    return this.#enqueue(async () => {
      this.#assertUsable(parent);
      const scope = new Scope(this, parent, parent.level + 1);
      await this.#run(`savepoint ${scope.savepoint}`, []);
      this.active = scope;
      return scope;
    });
  }

  releaseNested(scope: Scope): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertUsable(scope);
      if (supportsReleaseSavepoint(this.dialect)) await this.#run(`release savepoint ${scope.savepoint}`, []);
      // Committed into the outer level: its callbacks wait for the outermost commit.
      scope.parent!.callbacks.push(...scope.callbacks);
      this.#close(scope);
    });
  }

  rollbackNested(scope: Scope): Promise<void> {
    return this.#enqueue(async () => {
      try {
        if (this.state === "open" && this.active === scope) {
          await this.#run(`rollback to savepoint ${scope.savepoint}`, []);
        }
      } finally {
        this.#close(scope);
      }
    });
  }

  #close(scope: Scope) {
    scope.closed = true;
    scope.callbacks.length = 0;
    if (this.active === scope && scope.parent) this.active = scope.parent;
  }

  commit(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.state === "open" && this.active !== this.scope) {
        throw new ConcurrentTransactionError(
          "Tenora: the transaction finished while a nested transaction inside it was still running. Await every nested transaction()."
        );
      }
      this.#assertUsable(this.scope);
      this.state = "committing";
      let result: DriverResult;
      try {
        result = await this.client.query("commit", []);
      } catch (cause) {
        const kind = this.pool.classify(cause);
        if (kind === "connection_lost") {
          this.state = "unknown";
          this.#broken = true;
          throw new TransactionOutcomeUnknownError(
            "Tenora: the connection was lost during COMMIT, so it is unknown whether the transaction was committed.",
            { cause }
          );
        }
        this.state = "rolled_back";
        throw new QueryError(cause, kind, "commit", []);
      }
      if (result.command && result.command.toUpperCase() !== "COMMIT") {
        this.state = "rolled_back";
        throw new TransactionAbortedError(
          "Tenora: Postgres rolled the transaction back instead of committing it, because a statement in it had failed."
        );
      }
      this.state = "committed";
    });
  }

  /** Rolls back unless the transaction already ended. Queries still waiting in the queue are rejected, not run. */
  rollback(): Promise<void> {
    if (this.state !== "open" && this.state !== "aborted") return Promise.resolve();
    // Set before queueing, so the queries ahead of the ROLLBACK reject instead of running.
    this.state = "rolling_back";
    return this.#enqueue(async () => {
      try {
        await this.client.query("rollback", []);
      } catch {
        this.#broken = true;
      } finally {
        this.state = "rolled_back";
        this.#close(this.scope);
      }
    });
  }

  /** Returns the connection to the pool, or closes it if it may be in an unknown state. */
  async finish(): Promise<void> {
    await this.#tail;
    await this.pool.release(this.client, this.#broken);
  }

  /** Runs the after-commit callbacks of every level, in order. Called once the transaction committed. */
  async runAfterCommit(): Promise<void> {
    const callbacks = this.scope.callbacks.splice(0);
    this.scope.closed = true;
    let failure: unknown;
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw new AfterCommitError("Tenora: the transaction committed, but an afterCommit callback failed.", {
        cause: failure,
      });
    }
  }
}
