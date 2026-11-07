import { compile, type CompiledQuery } from "../compile";
import type { Connection, Transaction } from "../connection";
import { RawSql, sql } from "../sql";
import { type Conjunction, OPERATORS, type Operator, type SelectState, type Where } from "./state";

type Row = Record<string, unknown>;
type Column<R extends Row> = Extract<keyof R, string> | (string & {});
type WhereCallback<R extends Row> = (query: QueryBuilder<R>) => QueryBuilder<R>;

const assertCount = (name: string, value: number) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Tenora: ${name}() needs a whole number of 0 or more.`);
};

const normalizeOperator = (operator: string): Operator => {
  const normalized = operator.toLowerCase().replace(/\s+/g, " ").trim() as Operator;
  if (!OPERATORS.includes(normalized)) throw new Error(`Tenora: unknown operator "${operator}".`);
  return normalized;
};

/**
 * A query on one table, in the style of Laravel's query builder. Every method returns a new builder, so a base query
 * can be reused safely. Awaiting the builder runs it as a select.
 *
 * Where it runs is decided when it is executed: in the transaction passed to `using()`, otherwise in the transaction
 * open on its connection in the current async context, otherwise on a pooled connection.
 */
export class QueryBuilder<R extends Row = Row> implements PromiseLike<R[]> {
  private constructor(
    readonly connection: Connection,
    private readonly state: SelectState,
    private readonly transaction: Transaction | undefined
  ) {}

  /** @internal */
  static forTable<R extends Row>(connection: Connection, table: string): QueryBuilder<R> {
    return new QueryBuilder<R>(
      connection,
      {
        kind: "select",
        table,
        columns: [],
        distinct: false,
        wheres: [],
        orders: [],
        limit: undefined,
        offset: undefined,
        lock: undefined,
        skipLocked: false,
        aggregate: undefined,
      },
      undefined
    );
  }

  #with(changes: Partial<SelectState>, transaction = this.transaction): QueryBuilder<R> {
    return new QueryBuilder<R>(this.connection, { ...this.state, ...changes }, transaction);
  }

  #addWhere(where: Where): QueryBuilder<R> {
    return this.#with({ wheres: [...this.state.wheres, where] });
  }

  /** Runs this query in an explicit transaction from `beginTransaction()`. */
  using(transaction: Transaction): QueryBuilder<R> {
    return this.#with({}, transaction);
  }

  select(...columns: Column<R>[]): QueryBuilder<R> {
    return this.#with({ columns: [...this.state.columns, ...columns] });
  }

  distinct(): QueryBuilder<R> {
    return this.#with({ distinct: true });
  }

  #where(boolean: Conjunction, args: unknown[]): QueryBuilder<R> {
    const [column, second, third] = args;
    if (typeof column === "function") {
      const nested = (column as WhereCallback<R>)(QueryBuilder.forTable<R>(this.connection, this.state.table));
      if (!nested.state.wheres.length) return this;
      return this.#addWhere({ type: "nested", wheres: nested.state.wheres, boolean });
    }
    if (typeof column !== "string") throw new Error("Tenora: where() needs a column name or a callback.");
    const operator = args.length === 2 ? "=" : normalizeOperator(String(second));
    const value = args.length === 2 ? second : third;
    // where("deleted_at", null) means IS NULL, as in Eloquent; "= NULL" never matches anything.
    if (value === null && (operator === "=" || operator === "!=" || operator === "<>")) {
      return this.#addWhere({ type: "null", column, not: operator !== "=", boolean });
    }
    if (value === undefined) {
      throw new Error(`Tenora: where("${column}") got undefined; pass null to compare with NULL.`);
    }
    return this.#addWhere({ type: "basic", column, operator, value, boolean });
  }

  where(callback: WhereCallback<R>): QueryBuilder<R>;
  where<C extends Column<R>>(column: C, value: C extends keyof R ? R[C] | RawSql : unknown): QueryBuilder<R>;
  where<C extends Column<R>>(
    column: C,
    operator: Operator | (string & {}),
    value: C extends keyof R ? R[C] | RawSql : unknown
  ): QueryBuilder<R>;
  where(...args: unknown[]): QueryBuilder<R> {
    return this.#where("and", args);
  }

  orWhere(callback: WhereCallback<R>): QueryBuilder<R>;
  orWhere<C extends Column<R>>(column: C, value: C extends keyof R ? R[C] | RawSql : unknown): QueryBuilder<R>;
  orWhere<C extends Column<R>>(
    column: C,
    operator: Operator | (string & {}),
    value: C extends keyof R ? R[C] | RawSql : unknown
  ): QueryBuilder<R>;
  orWhere(...args: unknown[]): QueryBuilder<R> {
    return this.#where("or", args);
  }

  whereIn(column: Column<R>, values: readonly unknown[]): QueryBuilder<R> {
    return this.#addWhere({ type: "in", column, values: [...values], not: false, boolean: "and" });
  }

  whereNotIn(column: Column<R>, values: readonly unknown[]): QueryBuilder<R> {
    return this.#addWhere({ type: "in", column, values: [...values], not: true, boolean: "and" });
  }

  orWhereIn(column: Column<R>, values: readonly unknown[]): QueryBuilder<R> {
    return this.#addWhere({ type: "in", column, values: [...values], not: false, boolean: "or" });
  }

  whereNull(column: Column<R>): QueryBuilder<R> {
    return this.#addWhere({ type: "null", column, not: false, boolean: "and" });
  }

  whereNotNull(column: Column<R>): QueryBuilder<R> {
    return this.#addWhere({ type: "null", column, not: true, boolean: "and" });
  }

  /** A raw condition: `whereRaw(sql\`lower(${sql.ref("email")}) = ${email}\`)`. */
  whereRaw(fragment: RawSql): QueryBuilder<R> {
    return this.#addWhere({ type: "raw", sql: fragment, boolean: "and" });
  }

  orderBy(column: Column<R> | RawSql, direction: "asc" | "desc" = "asc"): QueryBuilder<R> {
    if (direction !== "asc" && direction !== "desc") throw new Error(`Tenora: unknown order direction "${direction}".`);
    return this.#with({ orders: [...this.state.orders, { column, direction }] });
  }

  latest(column: Column<R> = "created_at"): QueryBuilder<R> {
    return this.orderBy(column, "desc");
  }

  oldest(column: Column<R> = "created_at"): QueryBuilder<R> {
    return this.orderBy(column, "asc");
  }

  limit(count: number): QueryBuilder<R> {
    assertCount("limit", count);
    return this.#with({ limit: count });
  }

  offset(count: number): QueryBuilder<R> {
    assertCount("offset", count);
    return this.#with({ offset: count });
  }

  /** Locks the selected rows until the transaction ends (a no-op on SQLite, where the transaction locks the file). */
  forUpdate(): QueryBuilder<R> {
    return this.#with({ lock: "update" });
  }

  /** With `forUpdate()`, skips rows another transaction has locked instead of waiting for them. */
  skipLocked(): QueryBuilder<R> {
    return this.#with({ lock: "update", skipLocked: true });
  }

  /** The SQL and parameters this query would run as a select. */
  toSql(): CompiledQuery {
    return compile(this.connection.dialect, this.state);
  }

  #run(build: () => CompiledQuery) {
    try {
      return this.connection.execute(build(), this.transaction);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  get(): Promise<R[]> {
    return this.#run(() => this.toSql()).then((result) => result.rows as R[]);
  }

  then<A = R[], B = never>(
    onfulfilled?: ((rows: R[]) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return this.get().then(onfulfilled, onrejected);
  }

  first(): Promise<R | undefined> {
    return this.limit(1).get().then((rows) => rows[0]);
  }

  async pluck<C extends Extract<keyof R, string>>(column: C): Promise<R[C][]> {
    const rows = await this.#with({ columns: [column] }).get();
    return rows.map((row) => row[column]);
  }

  #aggregate(fn: "count" | "sum" | "avg" | "min" | "max", column: string): Promise<unknown> {
    const query = this.#with({ aggregate: { fn, column }, orders: [], limit: undefined, offset: undefined });
    return query.#run(() => compile(this.connection.dialect, query.state)).then((result) => result.rows[0]?.aggregate);
  }

  /** Counts the matching rows. Postgres returns counts as text; this always returns a number. */
  async count(column: Column<R> = "*"): Promise<number> {
    return Number((await this.#aggregate("count", column)) ?? 0);
  }

  async exists(): Promise<boolean> {
    return (await this.first()) !== undefined;
  }

  /** Inserts one row or several, and returns how many were inserted. */
  async insert(values: Partial<R> | readonly Partial<R>[]): Promise<number> {
    const rows = (Array.isArray(values) ? values : [values]) as Row[];
    if (!rows.length) return 0;
    const result = await this.#run(() =>
      compile(this.connection.dialect, { kind: "insert", table: this.state.table, rows, returning: undefined })
    );
    return result.affectedRows;
  }

  /** Inserts one row and returns its generated id. */
  async insertGetId(values: Partial<R>, idColumn: Column<R> = "id"): Promise<number | string | bigint> {
    const result = await this.#run(() =>
      compile(this.connection.dialect, {
        kind: "insert",
        table: this.state.table,
        rows: [values as Row],
        returning: [idColumn],
      })
    );
    const returned = result.rows[0]?.[idColumn];
    const id = returned ?? result.insertId;
    if (id === undefined || id === null) throw new Error("Tenora: the database did not return the inserted id.");
    return id as number | string | bigint;
  }

  #assertWhole(action: string) {
    if (this.state.limit !== undefined || this.state.offset !== undefined || this.state.orders.length) {
      throw new Error(`Tenora: ${action}() ignores limit, offset and orderBy; remove them, or select the ids first.`);
    }
  }

  /** Updates the matching rows and returns how many changed. */
  async update(values: Partial<R> | Record<string, RawSql | unknown>): Promise<number> {
    this.#assertWhole("update");
    const result = await this.#run(() =>
      compile(this.connection.dialect, {
        kind: "update",
        table: this.state.table,
        values: values as Row,
        wheres: this.state.wheres,
      })
    );
    return result.affectedRows;
  }

  increment(column: Column<R>, amount = 1, extra: Partial<R> = {}): Promise<number> {
    if (!Number.isFinite(amount)) throw new Error("Tenora: increment() needs a finite number.");
    return this.update({ ...extra, [column]: sql`${sql.ref(column)} + ${amount}` });
  }

  decrement(column: Column<R>, amount = 1, extra: Partial<R> = {}): Promise<number> {
    if (!Number.isFinite(amount)) throw new Error("Tenora: decrement() needs a finite number.");
    return this.update({ ...extra, [column]: sql`${sql.ref(column)} - ${amount}` });
  }

  /** Deletes the matching rows and returns how many were deleted. */
  async delete(): Promise<number> {
    this.#assertWhole("delete");
    const result = await this.#run(() =>
      compile(this.connection.dialect, { kind: "delete", table: this.state.table, wheres: this.state.wheres })
    );
    return result.affectedRows;
  }
}
