import { AsyncLocalStorage } from "node:async_hooks";
import { compileRaw } from "../../compile";
import type { Connection } from "../../connection";
import { RawSql, sql } from "../../sql";
import { runnerFor } from "../runner";
import { KnexTableBuilder } from "./blueprint";
import {
  compileKnexDropTable,
  compileKnexRaw,
  compileKnexRenameTable,
  compileKnexTable,
  type KnexCompatOptions,
  type KnexStatement,
} from "./compiler";

type TableCallback = (this: KnexTableBuilder, table: KnexTableBuilder) => unknown;

/** Knex's raw text: `?` is a value, `??` an identifier, and `\?` a literal question mark. */
const fromKnexRaw = (text: string, bindings: readonly unknown[]): RawSql => {
  const strings = [""];
  const values: unknown[] = [];
  let next = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && text[i + 1] === "?") {
      strings[strings.length - 1] += "?";
      i++;
    } else if (text[i] === "?") {
      if (next >= bindings.length) throw new Error("Tenora: raw() has more placeholders than bindings.");
      const identifier = text[i + 1] === "?";
      values.push(identifier ? sql.ref(String(bindings[next])) : bindings[next]);
      next++;
      if (identifier) i++;
      strings.push("");
    } else {
      strings[strings.length - 1] += text[i];
    }
  }
  if (next !== bindings.length) throw new Error("Tenora: raw() has more bindings than placeholders.");
  return new RawSql(strings, values);
};

type Operation =
  | { readonly kind: "create" | "createIfNot" | "alter"; readonly table: string; readonly callback: TableCallback }
  | { readonly kind: "drop" | "dropIfExists"; readonly table: string }
  | { readonly kind: "rename"; readonly from: string; readonly to: string }
  | { readonly kind: "raw"; readonly fragment: RawSql };

/**
 * Knex's schema builder, for migrations converted from 0.x: the same method names, and exactly the SQL Knex 3.3
 * writes on each database, so tenants migrated before and after the upgrade get the same schema.
 *
 * Calls chain as in Knex (`schema.createTable(…).createTable(…)`), and awaiting the builder runs them in order. Every
 * call returns a new builder, so two separate calls on one `schema` never run each other's changes. Like
 * `SchemaChange`, a builder runs in the async context it was created in, so one returned from a `transaction()`
 * callback runs in that transaction.
 */
export class KnexSchemaBuilder implements PromiseLike<void> {
  readonly #context = AsyncLocalStorage.snapshot();

  /** @internal */
  constructor(
    private readonly connection: Connection,
    private readonly operations: readonly Operation[] = [],
    private readonly options: KnexCompatOptions = {}
  ) {}

  #add(operation: Operation): KnexSchemaBuilder {
    return new KnexSchemaBuilder(this.connection, [...this.operations, operation], this.options);
  }

  /**
   * The MySQL charset and collation Knex took from the 0.x connection config (`connection.charset`/`collate`) and
   * added to every CREATE TABLE.
   */
  withOptions(options: KnexCompatOptions): KnexSchemaBuilder {
    return new KnexSchemaBuilder(this.connection, this.operations, { ...this.options, ...options });
  }

  createTable(table: string, callback: TableCallback): KnexSchemaBuilder {
    return this.#add({ kind: "create", table, callback });
  }

  createTableIfNotExists(table: string, callback: TableCallback): KnexSchemaBuilder {
    return this.#add({ kind: "createIfNot", table, callback });
  }

  alterTable(table: string, callback: TableCallback): KnexSchemaBuilder {
    return this.#add({ kind: "alter", table, callback });
  }

  table(table: string, callback: TableCallback): KnexSchemaBuilder {
    return this.alterTable(table, callback);
  }

  dropTable(table: string): KnexSchemaBuilder {
    return this.#add({ kind: "drop", table });
  }

  dropTableIfExists(table: string): KnexSchemaBuilder {
    return this.#add({ kind: "dropIfExists", table });
  }

  renameTable(from: string, to: string): KnexSchemaBuilder {
    return this.#add({ kind: "rename", from, to });
  }

  /**
   * SQL run in its place among the other changes, as Knex's `schema.raw()`: a `sql` fragment, or text with `?`
   * placeholders for `bindings` (and `??` for identifiers).
   */
  raw(fragment: RawSql | string, bindings: readonly unknown[] = []): KnexSchemaBuilder {
    return this.#add({ kind: "raw", fragment: typeof fragment === "string" ? fromKnexRaw(fragment, bindings) : fragment });
  }

  #statements(): KnexStatement[] {
    const { dialect } = this.connection;
    return this.operations.flatMap((operation): KnexStatement[] => {
      switch (operation.kind) {
        case "create":
        case "createIfNot":
        case "alter": {
          const table = new KnexTableBuilder(dialect, operation.kind, operation.table);
          if (typeof operation.callback !== "function") {
            throw new TypeError("Tenora: createTable() and alterTable() need a callback.");
          }
          operation.callback.call(table, table);
          return compileKnexTable(dialect, table, this.options);
        }
        case "drop":
        case "dropIfExists":
          return [compileKnexDropTable(dialect, operation.table, operation.kind === "dropIfExists")];
        case "rename":
          return [compileKnexRenameTable(dialect, operation.from, operation.to)];
        case "raw":
          return [compileKnexRaw(dialect, operation.fragment)];
      }
    });
  }

  /**
   * The statements as Knex's `toSQL()` reports them: SQL with `?` placeholders, and bindings. Where Knex reads the
   * database before it alters (most SQLite changes, a MySQL column rename), this is the query it starts with.
   */
  toSQL(): { sql: string; bindings: unknown[] }[] {
    return this.#statements().map(({ sql, bindings }) => ({ sql, bindings: [...bindings] }));
  }

  async #run(): Promise<void> {
    const runner = runnerFor(this.connection);
    for (const statement of this.#statements()) {
      if (statement.run) await statement.run(runner);
      else await this.connection.execute(compileRaw(this.connection.dialect, statement.raw));
    }
  }

  then<T = void, E = never>(
    onfulfilled?: ((value: void) => T | PromiseLike<T>) | null,
    onrejected?: ((reason: unknown) => E | PromiseLike<E>) | null
  ): Promise<T | E> {
    return this.#context(() => this.#run()).then(onfulfilled, onrejected);
  }
}
