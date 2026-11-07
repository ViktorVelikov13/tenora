import { AsyncLocalStorage } from "node:async_hooks";
import type { CompiledQuery } from "../compile";
import { compileSchema } from "../compileSchema";
import type { Connection } from "../connection";
import { Blueprint } from "./blueprint";
import { compileBlueprint } from "./grammar";
import { KnexSchemaBuilder } from "./knex/builder";
import { runnerFor, runSteps, type SchemaStep } from "./runner";
import { suspendForeignKeys } from "./sqlite";

/**
 * A schema change, run when awaited. `toSql()` shows its statements without running them; a SQLite change that
 * rebuilds the table reads the table first, so it shows as a comment.
 *
 * It runs in the async context it was created in, so a change returned unawaited from a `transaction()` callback
 * (`transaction(() => db.schema.create(…))`, as a migration's `up` does) still runs in that transaction: `await` calls
 * `then()` only after the callback has returned.
 */
export class SchemaChange implements PromiseLike<void> {
  readonly #context = AsyncLocalStorage.snapshot();
  #steps: SchemaStep[] | undefined;

  /** @internal */
  constructor(
    private readonly connection: Connection,
    private readonly build: () => SchemaStep[]
  ) {}

  #compiled(): SchemaStep[] {
    this.#steps ??= this.build();
    return this.#steps;
  }

  toSql(): CompiledQuery[] {
    return this.#compiled().map((step) => (step.kind === "sql" ? step.compiled : { sql: step.description, parameters: [] }));
  }

  then<T = void, E = never>(
    onfulfilled?: ((value: void) => T | PromiseLike<T>) | null,
    onrejected?: ((reason: unknown) => E | PromiseLike<E>) | null
  ): Promise<T | E> {
    return this.#context(() => Promise.resolve().then(() => runSteps(runnerFor(this.connection), this.#compiled()))).then(
      onfulfilled,
      onrejected
    );
  }
}

type BlueprintCallback = (table: Blueprint) => unknown;

/**
 * Creates and changes tables, in the style of Laravel's schema builder: `db.schema.create("users", (t) => { … })`.
 * Converted 0.x migrations use `db.schema.knex` instead, which writes the SQL Knex wrote.
 *
 * Statements run in the transaction open on the connection, if any. MySQL and MariaDB commit DDL implicitly, so
 * there a schema change ends the open transaction and cannot be rolled back.
 */
export class SchemaBuilder {
  /** @internal */
  constructor(private readonly connection: Connection) {}

  #change(build: () => SchemaStep[]) {
    return new SchemaChange(this.connection, build);
  }

  #blueprint(table: string, creating: boolean, callback: BlueprintCallback) {
    if (typeof callback !== "function") throw new TypeError("Tenora: a schema change needs a callback that defines the table.");
    const blueprint = new Blueprint(table, creating);
    const result = callback(blueprint);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      throw new Error("Tenora: the table callback must not be async; it only describes the table.");
    }
    return this.#change(() => compileBlueprint(this.connection.dialect, blueprint));
  }

  /** Creates a table: `create("users", (t) => { t.id(); t.string("email").unique(); t.timestamps(); })`. */
  create(table: string, callback: BlueprintCallback): SchemaChange {
    return this.#blueprint(table, true, callback);
  }

  /** Changes a table: adds, changes (`.change()`), renames and drops columns, keys and indexes. */
  table(table: string, callback: BlueprintCallback): SchemaChange {
    return this.#blueprint(table, false, callback);
  }

  drop(table: string): SchemaChange {
    return this.#change(() => [{ kind: "sql", compiled: compileSchema(this.connection.dialect, { kind: "dropTable", table, ifExists: false }) }]);
  }

  dropIfExists(table: string): SchemaChange {
    return this.#change(() => [{ kind: "sql", compiled: compileSchema(this.connection.dialect, { kind: "dropTable", table, ifExists: true }) }]);
  }

  rename(from: string, to: string): SchemaChange {
    return this.#change(() => [{ kind: "sql", compiled: compileSchema(this.connection.dialect, { kind: "renameTable", from, to }) }]);
  }

  /**
   * SQLite only: runs `fn` with foreign key enforcement off. SQLite switches it only outside a transaction, so a
   * migration that rebuilds a referenced table inside a transaction opens that transaction inside `fn`. Every table
   * rebuild still checks its foreign keys before it commits.
   */
  withoutForeignKeyConstraints<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.connection.dialect !== "sqlite") {
      return Promise.reject(
        new Error("Tenora: withoutForeignKeyConstraints() is for SQLite, whose table rebuilds need it; other databases alter in place.")
      );
    }
    return suspendForeignKeys(runnerFor(this.connection), async () => fn());
  }

  /** Knex's schema builder, for migrations converted from 0.x; it writes exactly the SQL Knex 3.3 wrote. */
  get knex(): KnexSchemaBuilder {
    return new KnexSchemaBuilder(this.connection);
  }
}
