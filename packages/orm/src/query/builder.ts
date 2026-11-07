import { compile, type CompiledQuery } from "../compile";
import type { Connection, Transaction } from "../connection";
import { RawSql, sql } from "../sql";
import {
  type Conjunction,
  emptySelect,
  type Join,
  OPERATORS,
  type Operator,
  type SelectState,
  type Source,
  SubQuery,
  type Where,
} from "./state";

type Row = Record<string, unknown>;
type Column<R extends Row> = Extract<keyof R, string> | (string & {});
type Value<R extends Row, C> = C extends keyof R ? R[C] | RawSql | QueryBuilder<any> : unknown;
type Truthy<T> = Exclude<T, false | null | undefined | 0 | "">;

const assertCount = (name: string, value: number) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Tenora: ${name}() needs a whole number of 0 or more.`);
};

const normalizeOperator = (operator: unknown): Operator => {
  const normalized = String(operator).toLowerCase().replace(/\s+/g, " ").trim() as Operator;
  if (!OPERATORS.includes(normalized)) throw new Error(`Tenora: unknown operator "${String(operator)}".`);
  return normalized;
};

/** The key a selected column has in a result row: "users.name" → "name", "count(*) as n" → "n". */
const resultKey = (column: string) => {
  const alias = /\s+as\s+(.+)$/i.exec(column);
  return (alias ? alias[1] : column).split(".").pop()!.trim();
};

/** The table a write goes to, without the alias a select may give it. */
const baseTable = (name: string) => name.split(/\s+as\s+/i)[0].trim();

/**
 * Builders never change in place, so a callback has to return the builder it was given. Laravel's callbacks mutate
 * instead, so a block body without `return` is the likely mistake, and this says so instead of failing later.
 */
const returned = <T>(result: unknown, isExpected: (value: unknown) => value is T, where: string): T => {
  if (isExpected(result)) return result;
  throw new Error(
    `Tenora: the ${where} callback must return the builder it was given. Every method returns a new one, so write (q) => q.where(...), not (q) => { q.where(...); }.`
  );
};

/** Splits `(first, second)` and `(first, operator, second)` the way Laravel's `on` and `whereColumn` read them. */
const columnPair = (args: unknown[]): { first: string; operator: Operator; second: string } => {
  const [first, operatorOrSecond, second] = args;
  if (typeof first !== "string") throw new Error("Tenora: a column condition needs column names.");
  return args.length === 2
    ? { first, operator: "=", second: String(operatorOrSecond) }
    : { first, operator: normalizeOperator(operatorOrSecond), second: String(second) };
};

/** `(column, value)` or `(column, operator, value)`; comparing with null means IS NULL or IS NOT NULL. */
const valueCondition = (args: unknown[], boolean: Conjunction): Where => {
  const [column, second, third] = args;
  if (typeof column !== "string") throw new Error("Tenora: a condition needs a column name.");
  const operator = args.length === 2 ? "=" : normalizeOperator(second);
  const value = args.length === 2 ? second : third;
  // where("deleted_at", null) means IS NULL, as in Eloquent; "= NULL" never matches anything.
  if (value === null && (operator === "=" || operator === "!=" || operator === "<>")) {
    return { type: "null", column, not: operator !== "=", boolean };
  }
  if (value === undefined) throw new Error(`Tenora: where("${column}") got undefined; pass null to compare with NULL.`);
  return { type: "basic", column, operator, value, boolean };
};

/**
 * The conditions of a join, written in its callback:
 * `join("contacts", (j) => j.on("users.id", "contacts.user_id").where("contacts.active", true))`.
 * `on` compares two columns; `where` compares a column with a value, which is bound as a parameter.
 */
export class JoinClause {
  /** @internal */
  constructor(readonly conditions: readonly Where[] = []) {}

  #add(where: Where) {
    return new JoinClause([...this.conditions, where]);
  }

  on(first: string, second: string): JoinClause;
  on(first: string, operator: Operator | (string & {}), second: string): JoinClause;
  on(...args: unknown[]): JoinClause {
    return this.#add({ type: "column", ...columnPair(args), boolean: "and" });
  }

  orOn(first: string, second: string): JoinClause;
  orOn(first: string, operator: Operator | (string & {}), second: string): JoinClause;
  orOn(...args: unknown[]): JoinClause {
    return this.#add({ type: "column", ...columnPair(args), boolean: "or" });
  }

  where(column: string, value: unknown): JoinClause;
  where(column: string, operator: Operator | (string & {}), value: unknown): JoinClause;
  where(...args: unknown[]): JoinClause {
    return this.#add(valueCondition(args, "and"));
  }

  orWhere(column: string, value: unknown): JoinClause;
  orWhere(column: string, operator: Operator | (string & {}), value: unknown): JoinClause;
  orWhere(...args: unknown[]): JoinClause {
    return this.#add(valueCondition(args, "or"));
  }

  whereIn(column: string, values: readonly unknown[]): JoinClause {
    return this.#add({ type: "in", column, values: [...values], not: false, boolean: "and" });
  }

  whereNull(column: string): JoinClause {
    return this.#add({ type: "null", column, not: false, boolean: "and" });
  }

  whereNotNull(column: string): JoinClause {
    return this.#add({ type: "null", column, not: true, boolean: "and" });
  }
}

/** A subquery has to run on the same connection: a tenant query inside a base query would be two databases. */
const subqueryState = (connection: Connection, query: QueryBuilder<any>): SelectState => {
  if (query.connection !== connection) {
    throw new Error(
      "Tenora: a subquery must use the same connection as the query it is part of; two databases cannot be combined in one query."
    );
  }
  return query.selectState;
};

type JoinCallback = (join: JoinClause) => JoinClause;
type JoinArgs = [first: string, second: string] | [first: string, operator: Operator | (string & {}), second: string] | [JoinCallback];

/**
 * A query in the style of Laravel's query builder. Every method returns a new builder, so a base query can be reused
 * safely. Awaiting the builder runs it as a select.
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
    return new QueryBuilder<R>(connection, emptySelect({ type: "table", name: table }), undefined);
  }

  /** @internal */
  static fromSub<R extends Row>(connection: Connection, query: QueryBuilder<any>, alias: string): QueryBuilder<R> {
    const source: Source = { type: "sub", query: subqueryState(connection, query), alias };
    return new QueryBuilder<R>(connection, emptySelect(source), undefined);
  }

  /** @internal */
  get selectState(): SelectState {
    return this.state;
  }

  #with(changes: Partial<SelectState>, transaction = this.transaction): QueryBuilder<R> {
    return new QueryBuilder<R>(this.connection, { ...this.state, ...changes }, transaction);
  }

  /** The state of a query used inside this one, which has to be on the same connection. */
  #subquery(query: QueryBuilder<any>): SelectState {
    return subqueryState(this.connection, query);
  }

  #operand(value: unknown) {
    return value instanceof QueryBuilder ? new SubQuery(this.#subquery(value)) : value;
  }

  #addWhere(where: Where): QueryBuilder<R> {
    return this.#with({ wheres: [...this.state.wheres, where] });
  }

  /** Runs this query in an explicit transaction from `beginTransaction()`. */
  using(transaction: Transaction): QueryBuilder<R> {
    return this.#with({}, transaction);
  }

  /**
   * Applies `callback` only when `value` is truthy, passing it the value; `otherwise` runs when it is not:
   * `when(search, (q, term) => q.where("name", "like", `%${term}%`))`.
   */
  when<V>(
    value: V,
    callback: (query: QueryBuilder<R>, value: Truthy<V>) => QueryBuilder<R>,
    otherwise?: (query: QueryBuilder<R>) => QueryBuilder<R>
  ): QueryBuilder<R> {
    if (value) return returned(callback(this, value as Truthy<V>), isBuilder<R>, "when()");
    return otherwise ? returned(otherwise(this), isBuilder<R>, "when()") : this;
  }

  // Selecting

  /** Columns to select, added to any selected before: `select("id", "users.name", "email as contact")`. */
  select(...columns: Column<R>[]): QueryBuilder<R> {
    return this.#with({ columns: [...this.state.columns, ...columns.map((name) => ({ type: "column" as const, name }))] });
  }

  /** A raw expression to select: `selectRaw(sql\`count(*) as orders\`)`. */
  selectRaw(fragment: RawSql): QueryBuilder<R> {
    return this.#with({ columns: [...this.state.columns, { type: "raw", sql: fragment }] });
  }

  /** A subquery's single value as a column: `selectSub(db.table("orders").selectRaw(sql\`count(*)\`).whereColumn(...), "orders_count")`. */
  selectSub(query: QueryBuilder<any>, alias: string): QueryBuilder<R> {
    return this.#with({ columns: [...this.state.columns, { type: "sub", query: this.#subquery(query), alias }] });
  }

  distinct(): QueryBuilder<R> {
    return this.#with({ distinct: true });
  }

  // Joining

  #join(type: Join["type"], source: Source, args: unknown[]): QueryBuilder<R> {
    let conditions: readonly Where[] = [];
    if (type !== "cross") {
      if (typeof args[0] === "function") {
        conditions = returned((args[0] as JoinCallback)(new JoinClause()), isJoinClause, "join").conditions;
      }
      else conditions = [{ type: "column", ...columnPair(args), boolean: "and" }];
    }
    return this.#with({ joins: [...this.state.joins, { type, source, conditions }] });
  }

  /**
   * An inner join: `join("customers", "customers.id", "orders.customer_id")`, with an operator as the middle argument
   * when it is not `=`, or a callback for more conditions: `join("contacts", (j) => j.on(...).where(...))`.
   */
  join(table: string, ...args: JoinArgs): QueryBuilder<R> {
    return this.#join("inner", { type: "table", name: table }, args);
  }

  leftJoin(table: string, ...args: JoinArgs): QueryBuilder<R> {
    return this.#join("left", { type: "table", name: table }, args);
  }

  /** On SQLite, RIGHT JOIN needs SQLite 3.39 or newer (better-sqlite3 bundles a newer one). */
  rightJoin(table: string, ...args: JoinArgs): QueryBuilder<R> {
    return this.#join("right", { type: "table", name: table }, args);
  }

  crossJoin(table: string): QueryBuilder<R> {
    return this.#join("cross", { type: "table", name: table }, []);
  }

  /** Joins a subquery under an alias: `joinSub(latestOrders, "latest", "latest.customer_id", "customers.id")`. */
  joinSub(query: QueryBuilder<any>, alias: string, ...args: JoinArgs): QueryBuilder<R> {
    return this.#join("inner", { type: "sub", query: this.#subquery(query), alias }, args);
  }

  leftJoinSub(query: QueryBuilder<any>, alias: string, ...args: JoinArgs): QueryBuilder<R> {
    return this.#join("left", { type: "sub", query: this.#subquery(query), alias }, args);
  }

  // Filtering

  #where(boolean: Conjunction, args: unknown[]): QueryBuilder<R> {
    const [column, second, third] = args;
    if (typeof column === "function") {
      const nested = returned(
        (column as (query: QueryBuilder<R>) => unknown)(
          new QueryBuilder<R>(this.connection, emptySelect(this.state.from), undefined)
        ),
        isBuilder<R>,
        "where()"
      );
      if (!nested.state.wheres.length) return this;
      return this.#addWhere({ type: "nested", wheres: nested.state.wheres, boolean });
    }
    if (typeof column !== "string") throw new Error("Tenora: where() needs a column name or a callback.");
    const where = valueCondition(args, boolean);
    return this.#addWhere(where.type === "basic" ? { ...where, value: this.#operand(where.value) } : where);
  }

  /**
   * `where("votes", 100)`, `where("votes", ">", 100)`, a subquery as the value, or a callback for a group in
   * parentheses: `where((q) => q.where("a", 1).orWhere("b", 2))`.
   */
  where(callback: (query: QueryBuilder<R>) => QueryBuilder<R>): QueryBuilder<R>;
  where<C extends Column<R>>(column: C, value: Value<R, C> | null): QueryBuilder<R>;
  where<C extends Column<R>>(column: C, operator: Operator | (string & {}), value: Value<R, C> | null): QueryBuilder<R>;
  where(...args: unknown[]): QueryBuilder<R> {
    return this.#where("and", args);
  }

  orWhere(callback: (query: QueryBuilder<R>) => QueryBuilder<R>): QueryBuilder<R>;
  orWhere<C extends Column<R>>(column: C, value: Value<R, C> | null): QueryBuilder<R>;
  orWhere<C extends Column<R>>(column: C, operator: Operator | (string & {}), value: Value<R, C> | null): QueryBuilder<R>;
  orWhere(...args: unknown[]): QueryBuilder<R> {
    return this.#where("or", args);
  }

  /** Compares two columns: `whereColumn("updated_at", ">", "created_at")`. */
  whereColumn(first: Column<R>, second: Column<R>): QueryBuilder<R>;
  whereColumn(first: Column<R>, operator: Operator | (string & {}), second: Column<R>): QueryBuilder<R>;
  whereColumn(...args: unknown[]): QueryBuilder<R> {
    return this.#addWhere({ type: "column", ...columnPair(args), boolean: "and" });
  }

  orWhereColumn(first: Column<R>, second: Column<R>): QueryBuilder<R>;
  orWhereColumn(first: Column<R>, operator: Operator | (string & {}), second: Column<R>): QueryBuilder<R>;
  orWhereColumn(...args: unknown[]): QueryBuilder<R> {
    return this.#addWhere({ type: "column", ...columnPair(args), boolean: "or" });
  }

  #in(column: string, values: readonly unknown[] | QueryBuilder<any>, not: boolean, boolean: Conjunction) {
    return this.#addWhere({
      type: "in",
      column,
      values: values instanceof QueryBuilder ? new SubQuery(this.#subquery(values)) : [...values],
      not,
      boolean,
    });
  }

  /** `whereIn("id", [1, 2, 3])`, or a subquery: `whereIn("id", db.table("orders").select("customer_id"))`. */
  whereIn(column: Column<R>, values: readonly unknown[] | QueryBuilder<any>): QueryBuilder<R> {
    return this.#in(column, values, false, "and");
  }

  whereNotIn(column: Column<R>, values: readonly unknown[] | QueryBuilder<any>): QueryBuilder<R> {
    return this.#in(column, values, true, "and");
  }

  orWhereIn(column: Column<R>, values: readonly unknown[] | QueryBuilder<any>): QueryBuilder<R> {
    return this.#in(column, values, false, "or");
  }

  orWhereNotIn(column: Column<R>, values: readonly unknown[] | QueryBuilder<any>): QueryBuilder<R> {
    return this.#in(column, values, true, "or");
  }

  whereNull(column: Column<R>): QueryBuilder<R> {
    return this.#addWhere({ type: "null", column, not: false, boolean: "and" });
  }

  whereNotNull(column: Column<R>): QueryBuilder<R> {
    return this.#addWhere({ type: "null", column, not: true, boolean: "and" });
  }

  orWhereNull(column: Column<R>): QueryBuilder<R> {
    return this.#addWhere({ type: "null", column, not: false, boolean: "or" });
  }

  orWhereNotNull(column: Column<R>): QueryBuilder<R> {
    return this.#addWhere({ type: "null", column, not: true, boolean: "or" });
  }

  /** Inclusive at both ends: `whereBetween("price", [10, 20])`. */
  whereBetween(column: Column<R>, [low, high]: readonly [unknown, unknown]): QueryBuilder<R> {
    return this.#addWhere({ type: "between", column, low, high, not: false, boolean: "and" });
  }

  whereNotBetween(column: Column<R>, [low, high]: readonly [unknown, unknown]): QueryBuilder<R> {
    return this.#addWhere({ type: "between", column, low, high, not: true, boolean: "and" });
  }

  /** Rows for which the subquery finds at least one row, usually correlated with `whereColumn`. */
  whereExists(query: QueryBuilder<any>): QueryBuilder<R> {
    return this.#addWhere({ type: "exists", query: this.#subquery(query), not: false, boolean: "and" });
  }

  whereNotExists(query: QueryBuilder<any>): QueryBuilder<R> {
    return this.#addWhere({ type: "exists", query: this.#subquery(query), not: true, boolean: "and" });
  }

  /** A raw condition: `whereRaw(sql\`lower(${sql.ref("email")}) = ${email}\`)`. */
  whereRaw(fragment: RawSql): QueryBuilder<R> {
    return this.#addWhere({ type: "raw", sql: fragment, boolean: "and" });
  }

  orWhereRaw(fragment: RawSql): QueryBuilder<R> {
    return this.#addWhere({ type: "raw", sql: fragment, boolean: "or" });
  }

  // Grouping

  groupBy(...columns: Column<R>[]): QueryBuilder<R> {
    return this.#with({ groups: [...this.state.groups, ...columns] });
  }

  #having(boolean: Conjunction, args: unknown[]): QueryBuilder<R> {
    const [column, second, third] = args as [string, unknown, unknown];
    const where: Where =
      args.length === 2
        ? { type: "basic", column, operator: "=", value: second, boolean }
        : { type: "basic", column, operator: normalizeOperator(second), value: third, boolean };
    return this.#with({ havings: [...this.state.havings, where] });
  }

  /**
   * A condition on a grouped column. Postgres does not accept a select alias here; `havingRaw` with the expression
   * works everywhere: `havingRaw(sql\`count(*) > ${5}\`)`.
   */
  having(column: string, value: unknown): QueryBuilder<R>;
  having(column: string, operator: Operator | (string & {}), value: unknown): QueryBuilder<R>;
  having(...args: unknown[]): QueryBuilder<R> {
    return this.#having("and", args);
  }

  orHaving(column: string, value: unknown): QueryBuilder<R>;
  orHaving(column: string, operator: Operator | (string & {}), value: unknown): QueryBuilder<R>;
  orHaving(...args: unknown[]): QueryBuilder<R> {
    return this.#having("or", args);
  }

  havingRaw(fragment: RawSql): QueryBuilder<R> {
    return this.#with({ havings: [...this.state.havings, { type: "raw", sql: fragment, boolean: "and" }] });
  }

  // Ordering and paging

  orderBy(column: Column<R> | RawSql, direction?: "asc" | "desc"): QueryBuilder<R> {
    if (column instanceof RawSql) {
      if (direction) throw new Error("Tenora: a raw orderBy carries its own direction: orderBy(sql`... desc`).");
      return this.orderByRaw(column);
    }
    direction ??= "asc";
    if (direction !== "asc" && direction !== "desc") throw new Error(`Tenora: unknown order direction "${direction}".`);
    return this.#with({ orders: [...this.state.orders, { type: "column", column, direction }] });
  }

  orderByDesc(column: Column<R>): QueryBuilder<R> {
    return this.orderBy(column, "desc");
  }

  orderByRaw(fragment: RawSql): QueryBuilder<R> {
    return this.#with({ orders: [...this.state.orders, { type: "raw", sql: fragment }] });
  }

  latest(column: Column<R> = "created_at"): QueryBuilder<R> {
    return this.orderBy(column, "desc");
  }

  oldest(column: Column<R> = "created_at"): QueryBuilder<R> {
    return this.orderBy(column, "asc");
  }

  inRandomOrder(): QueryBuilder<R> {
    return this.#with({ orders: [...this.state.orders, { type: "random" }] });
  }

  limit(count: number): QueryBuilder<R> {
    assertCount("limit", count);
    return this.#with({ limit: count });
  }

  offset(count: number): QueryBuilder<R> {
    assertCount("offset", count);
    return this.#with({ offset: count });
  }

  /** One page of results, counting pages from 1: `forPage(2, 20)` is rows 21 to 40. */
  forPage(page: number, perPage = 15): QueryBuilder<R> {
    if (!Number.isInteger(page) || page < 1) throw new Error("Tenora: forPage() counts pages from 1.");
    assertCount("forPage", perPage);
    return this.offset((page - 1) * perPage).limit(perPage);
  }

  // Combining

  /** Rows of both queries, without duplicates. `orderBy` and `limit` on this query apply to the combined result. */
  union(query: QueryBuilder<any>): QueryBuilder<R> {
    return this.#with({ unions: [...this.state.unions, { query: this.#subquery(query), all: false }] });
  }

  unionAll(query: QueryBuilder<any>): QueryBuilder<R> {
    return this.#with({ unions: [...this.state.unions, { query: this.#subquery(query), all: true }] });
  }

  // Locking

  /**
   * Locks the selected rows until the transaction ends. On SQL Server this is an UPDLOCK hint on the main table only;
   * on SQLite it does nothing, because the transaction already locks the database.
   */
  forUpdate(): QueryBuilder<R> {
    return this.#with({ lock: "update" });
  }

  /** Lets other transactions read the selected rows but not change them until this transaction ends. */
  sharedLock(): QueryBuilder<R> {
    return this.#with({ lock: "share" });
  }

  /** With a lock, skips rows another transaction has locked instead of waiting for them. */
  skipLocked(): QueryBuilder<R> {
    return this.#with({ lock: this.state.lock ?? "update", skipLocked: true });
  }

  // Running selects

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

  get<T extends Row = R>(): Promise<T[]> {
    return this.#run(() => this.toSql()).then((result) => result.rows as T[]);
  }

  then<A = R[], B = never>(
    onfulfilled?: ((rows: R[]) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return this.get().then(onfulfilled, onrejected);
  }

  first<T extends Row = R>(): Promise<T | undefined> {
    return this.limit(1).get<T>().then((rows) => rows[0]);
  }

  /** The row whose `column` (default "id") equals `id`. */
  find<T extends Row = R>(id: unknown, column: Column<R> = "id"): Promise<T | undefined> {
    return this.where(column, id as any).first<T>();
  }

  /** One column of the first row: `value("email")`. */
  async value<V = unknown>(column: Column<R>): Promise<V | undefined> {
    const row = await this.#with({ columns: [{ type: "column", name: column }] }).first();
    return row?.[resultKey(column)] as V | undefined;
  }

  /** One column of every row: `pluck("email")`. */
  async pluck<C extends Column<R>>(column: C): Promise<(C extends keyof R ? R[C] : unknown)[]> {
    const rows = await this.#with({ columns: [{ type: "column", name: column }] }).get();
    const key = resultKey(column);
    return rows.map((row) => row[key]) as (C extends keyof R ? R[C] : unknown)[];
  }

  async exists(): Promise<boolean> {
    return (await this.first()) !== undefined;
  }

  async doesntExist(): Promise<boolean> {
    return !(await this.exists());
  }

  #aggregate(fn: "count" | "sum" | "avg" | "min" | "max", column: string): Promise<unknown> {
    const query = this.#with({
      aggregate: { fn, column },
      orders: [],
      limit: undefined,
      offset: undefined,
      lock: undefined,
      skipLocked: false,
    });
    return query.#run(() => query.toSql()).then((result) => result.rows[0]?.aggregate);
  }

  /**
   * Counts the matching rows; on a grouped, distinct or unioned query, counts the rows that query returns. Postgres
   * returns counts as text; this always returns a number.
   */
  async count(column: Column<R> = "*"): Promise<number> {
    return Number((await this.#aggregate("count", column)) ?? 0);
  }

  /** The sum as a number, or null when no rows match. A DECIMAL sum beyond JavaScript's precision is rounded. */
  async sum(column: Column<R>): Promise<number | null> {
    const value = await this.#aggregate("sum", column);
    return value === null || value === undefined ? null : Number(value);
  }

  /** The average as a number, or null when no rows match. */
  async avg(column: Column<R>): Promise<number | null> {
    const value = await this.#aggregate("avg", column);
    return value === null || value === undefined ? null : Number(value);
  }

  /** The smallest value as the database returns it (it may be a date or text), or undefined when no rows match. */
  async min<V = unknown>(column: Column<R>): Promise<V | undefined> {
    return ((await this.#aggregate("min", column)) ?? undefined) as V | undefined;
  }

  async max<V = unknown>(column: Column<R>): Promise<V | undefined> {
    return ((await this.#aggregate("max", column)) ?? undefined) as V | undefined;
  }

  // Writing

  #table(action: string) {
    const { from, joins, groups, unions } = this.state;
    if (from.type !== "table") throw new Error(`Tenora: ${action}() needs a table, not a subquery.`);
    if (joins.length || groups.length || unions.length) {
      throw new Error(`Tenora: ${action}() works on one table; remove the joins, groupBy and unions.`);
    }
    return from.name;
  }

  /** Inserts one row or several, and returns how many were inserted. */
  async insert(values: Partial<R> | readonly Partial<R>[]): Promise<number> {
    const rows = (Array.isArray(values) ? values : [values]) as Row[];
    if (!rows.length) return 0;
    const table = baseTable(this.#table("insert"));
    const result = await this.#run(() =>
      compile(this.connection.dialect, { kind: "insert", table, rows, returning: undefined })
    );
    return result.affectedRows;
  }

  /** Inserts one row and returns its generated id. */
  async insertGetId(values: Partial<R>, idColumn: Column<R> = "id"): Promise<number | string | bigint> {
    const table = baseTable(this.#table("insertGetId"));
    const result = await this.#run(() =>
      compile(this.connection.dialect, { kind: "insert", table, rows: [values as Row], returning: [idColumn] })
    );
    const id = result.rows[0]?.[idColumn] ?? result.insertId;
    if (id === undefined || id === null) throw new Error("Tenora: the database did not return the inserted id.");
    return id as number | string | bigint;
  }

  /**
   * Inserts rows, or updates the ones whose unique key already exists: `upsert(rows, ["email"], ["name"])`.
   * `update` defaults to every column not in `uniqueBy`; an empty list leaves existing rows as they are. Postgres and
   * SQLite need a unique index on exactly the `uniqueBy` columns; MySQL and MariaDB use whichever unique key the row
   * conflicts with. Returns the count the database reports, which counts an updated row twice on MySQL and MariaDB.
   */
  async upsert(
    values: Partial<R> | readonly Partial<R>[],
    uniqueBy: Column<R> | readonly Column<R>[],
    update?: readonly Column<R>[]
  ): Promise<number> {
    const rows = (Array.isArray(values) ? values : [values]) as Row[];
    if (!rows.length) return 0;
    const table = baseTable(this.#table("upsert"));
    const unique = (Array.isArray(uniqueBy) ? uniqueBy : [uniqueBy]) as string[];
    const columns = Object.keys(rows[0]);
    const updated = (update ?? columns.filter((column) => !unique.includes(column))) as string[];
    const result = await this.#run(() =>
      compile(this.connection.dialect, { kind: "upsert", table, rows, uniqueBy: unique, update: updated })
    );
    return result.affectedRows;
  }

  #assertWhole(action: string) {
    if (this.state.limit !== undefined || this.state.offset !== undefined || this.state.orders.length) {
      throw new Error(`Tenora: ${action}() ignores limit, offset and orderBy; remove them, or select the ids first.`);
    }
  }

  /** Updates the matching rows and returns how many changed. */
  async update(values: Partial<R> | Record<string, RawSql | unknown>): Promise<number> {
    this.#assertWhole("update");
    const table = this.#table("update");
    const result = await this.#run(() =>
      compile(this.connection.dialect, {
        kind: "update",
        table,
        values: Object.fromEntries(Object.entries(values).map(([column, value]) => [column, this.#operand(value)])),
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
    const table = this.#table("delete");
    const result = await this.#run(() =>
      compile(this.connection.dialect, { kind: "delete", table, wheres: this.state.wheres })
    );
    return result.affectedRows;
  }
}

const isBuilder = <R extends Row>(value: unknown): value is QueryBuilder<R> => value instanceof QueryBuilder;
const isJoinClause = (value: unknown): value is JoinClause => value instanceof JoinClause;
