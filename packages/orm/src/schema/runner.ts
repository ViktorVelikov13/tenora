import type { CompiledQuery } from "../compile";
import type { Connection } from "../connection";
import type { Dialect } from "../dialect";
import type { RawSql } from "../sql";

type Row = Record<string, unknown>;

/**
 * What a schema change needs from a connection. Statements run in the transaction open on the connection, if there
 * is one, so a migration that wraps its changes in a transaction gets them all in it.
 */
export interface SchemaRunner {
  readonly dialect: Dialect;
  /** the connection, which keys state kept per database connection */
  readonly owner: object;
  execute(compiled: CompiledQuery): Promise<Row[]>;
  query(fragment: RawSql): Promise<Row[]>;
  /** Runs `fn` in a transaction, or in a savepoint when one is already open. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** The runner for a connection: its ambient transaction applies, as it does to any query. */
export const runnerFor = (connection: Connection): SchemaRunner => ({
  dialect: connection.dialect,
  owner: connection,
  execute: (compiled) => connection.execute(compiled).then((result) => result.rows),
  query: (fragment) => connection.raw(fragment),
  transaction: (fn) => connection.transaction(fn),
});

/**
 * One step of a schema change: a statement, or work that has to read the database first (a SQLite table rebuild, a
 * Knex-style MySQL column rename). `description` is what `toSql()` shows for the second kind.
 */
export type SchemaStep =
  | { readonly kind: "sql"; readonly compiled: CompiledQuery }
  | { readonly kind: "run"; readonly description: string; readonly run: (runner: SchemaRunner) => Promise<void> };

export const runSteps = async (runner: SchemaRunner, steps: readonly SchemaStep[]): Promise<void> => {
  for (const step of steps) {
    if (step.kind === "sql") await runner.execute(step.compiled);
    else await step.run(runner);
  }
};
