/** What a database error means, independent of the driver that raised it. */
export type DatabaseErrorKind =
  | "unique_violation"
  | "foreign_key_violation"
  | "not_null_violation"
  | "deadlock"
  | "serialization_failure"
  | "lock_timeout"
  | "busy"
  | "connection_lost";

/** A query the database rejected. The driver's own error is `cause`; its code is copied to `code`. */
export class QueryError extends Error {
  override readonly name = "QueryError";
  readonly kind: DatabaseErrorKind | undefined;
  readonly code: string | number | undefined;
  readonly sql: string;
  readonly parameters: readonly unknown[];

  constructor(cause: unknown, kind: DatabaseErrorKind | undefined, sql: string, parameters: readonly unknown[]) {
    const original = cause as { message?: string; code?: string | number; errno?: number };
    // Parameters stay off the message, so they do not end up in logs.
    super(`${original?.message ?? String(cause)} (sql: ${sql})`, { cause });
    this.kind = kind;
    this.code = original?.code ?? original?.errno;
    this.sql = sql;
    this.parameters = parameters;
  }
}

/** Errors that a retried transaction can succeed after. */
export const isConcurrencyError = (error: unknown): boolean => {
  const kind = (error as { kind?: DatabaseErrorKind })?.kind;
  return kind === "deadlock" || kind === "serialization_failure" || kind === "lock_timeout" || kind === "busy";
};

/** A query or nested transaction that reached a transaction after it committed or rolled back. */
export class TransactionClosedError extends Error {
  override readonly name = "TransactionClosedError";
}

/**
 * The database did not commit. Postgres answers COMMIT with ROLLBACK when the transaction had already failed, and a
 * deadlock inside a nested transaction rolls back the whole transaction on MySQL.
 */
export class TransactionAbortedError extends Error {
  override readonly name = "TransactionAbortedError";
}

/** The connection was lost during COMMIT, so the transaction may or may not have been committed. */
export class TransactionOutcomeUnknownError extends Error {
  override readonly name = "TransactionOutcomeUnknownError";
}

/** A query from an outer transaction ran while one of its nested transactions was still open. */
export class ConcurrentTransactionError extends Error {
  override readonly name = "ConcurrentTransactionError";
}

/** The transaction committed, but an `afterCommit` callback threw. The transaction is not rolled back. */
export class AfterCommitError extends Error {
  override readonly name = "AfterCommitError";
  readonly committed = true;
}
