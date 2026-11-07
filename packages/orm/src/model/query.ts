import type { CompiledQuery } from "../compile";
import type { Connection, Transaction } from "../connection";
import { QueryError } from "../errors";
import { type JoinClause, QueryBuilder } from "../query/builder";
import type { Operator } from "../query/state";
import { RawSql } from "../sql";
import { ModelNotFoundError } from "./errors";
import { fire, hasListeners } from "./events";
import { freshTimestamp, internals, type Model, metaOf, type ModelMeta } from "./model";
import { globalScopesOf, type Scope } from "./scope";
import type {
  AttributeName,
  Attributes,
  ColumnOf,
  ModelClass,
  Page,
  Truthy,
  UpdateValues,
  ValueOf,
  WhereValue,
} from "./types";

type Op = Operator | (string & {});
type JoinArgs =
  | [first: string, second: string]
  | [first: string, operator: Op, second: string]
  | [callback: (join: JoinClause) => JoinClause];
type Subquery = QueryBuilder<any> | ModelQuery<any>;

type Options = {
  readonly transaction: Transaction | undefined;
  /** global scopes left out, by name, or all of them */
  readonly without: ReadonlySet<string> | "all";
  readonly onlyTrashed: boolean;
};

const SOFT_DELETES = "softDeletes";

const returned = <M extends Model>(result: unknown, where: string): ModelQuery<M> => {
  if (result instanceof ModelQuery) return result;
  throw new Error(
    `Tenora: the ${where} callback must return the query it was given. Every method returns a new one, so write (q) => q.where(...), not (q) => { q.where(...); }.`
  );
};

const toOperand = (value: unknown) => (value instanceof ModelQuery ? value.toBase() : value);

/**
 * Wraps the conditions from index `from` on in parentheses when they contain an OR, so that a condition added after
 * them (a global scope, soft deletes, a key) applies to all of them: `(a or b) and deleted_at is null`.
 */
const groupWheres = (builder: QueryBuilder, from: number): QueryBuilder => {
  const wheres = builder.selectState.wheres;
  const added = wheres.slice(from);
  if (!added.some((where, index) => where.boolean === "or" && (from > 0 || index > 0))) return builder;
  return builder.withState({ wheres: [...wheres.slice(0, from), { type: "nested", wheres: added, boolean: "and" }] });
};

/**
 * Maps an attribute name to its column: "createdAt" → "created_at", "users.createdAt" → "users.created_at",
 * "createdAt as joined" → "created_at as joined". Anything else (an expression, "*") is left as it is.
 */
const columnRef = (meta: ModelMeta, ref: string): string => {
  const alias = /^(.+?)\s+as\s+(.+)$/i.exec(ref);
  if (alias) return `${columnRef(meta, alias[1].trim())} as ${alias[2].trim()}`;
  if (!/^[\w$]+(\.[\w$]+)*$/.test(ref)) return ref;
  const dot = ref.lastIndexOf(".");
  if (dot === -1) return meta.columnOf(ref);
  const table = ref.slice(0, dot);
  const name = ref.slice(dot + 1);
  return `${table}.${table === meta.table ? meta.columnOf(name) : meta.naming.toColumn(name)}`;
};

/**
 * A query of a model: the query builder's methods, with attribute names mapped to columns, rows turned into model
 * instances, and the model's global scopes (soft deletes among them) applied when it runs. Like the builder, every
 * method returns a new query, and awaiting one runs it.
 */
export class ModelQuery<M extends Model> implements PromiseLike<M[]> {
  readonly #builder: QueryBuilder;
  readonly #options: Options;

  private constructor(
    readonly model: ModelClass<M>,
    builder: QueryBuilder,
    options: Options
  ) {
    this.#builder = builder;
    this.#options = options;
  }

  /** @internal */
  static create<M extends Model>(model: ModelClass<M>, connection: Connection, transaction?: Transaction): ModelQuery<M> {
    if (transaction && transaction.connection !== connection) {
      throw new Error("Tenora: that transaction belongs to a different connection.");
    }
    const builder = connection.table(metaOf(model).table);
    return new ModelQuery(model, transaction ? builder.using(transaction) : builder, {
      transaction,
      without: new Set(),
      onlyTrashed: false,
    });
  }

  /** The connection the query runs on. */
  get connection(): Connection {
    return this.#builder.connection;
  }

  get #meta(): ModelMeta {
    return metaOf(this.model);
  }

  #with(builder: QueryBuilder, options: Partial<Options> = {}): ModelQuery<M> {
    return new ModelQuery(this.model, builder, { ...this.#options, ...options });
  }

  #col(ref: string): string {
    return columnRef(this.#meta, ref);
  }

  #qualified(attribute: string): string {
    const meta = this.#meta;
    return `${meta.table}.${meta.columnOf(attribute)}`;
  }

  /** A copy whose conditions so far are grouped, before the model adds one of its own. */
  #grouped(): ModelQuery<M> {
    return this.#with(groupWheres(this.#builder, 0));
  }

  /** Runs `fn` inside the explicit transaction, if there is one, so model events join it too. */
  #run<T>(fn: () => Promise<T>): Promise<T> {
    const transaction = this.#options.transaction;
    return transaction ? transaction.run(fn) : fn();
  }

  /** Runs this query in a transaction from `beginTransaction()`. Models it loads do not stay pinned to it. */
  using(transaction: Transaction): ModelQuery<M> {
    if (transaction.connection !== this.connection) {
      throw new Error("Tenora: that transaction belongs to a different connection.");
    }
    return this.#with(this.#builder.using(transaction), { transaction });
  }

  /** Applies a local scope: `apply(User.active)`, or with arguments `apply(User.ofRole, "admin")`. */
  apply<A extends unknown[]>(scope: (query: ModelQuery<M>, ...args: A) => ModelQuery<M>, ...args: A): ModelQuery<M> {
    return returned<M>(scope(this, ...args), "scope");
  }

  /** Applies `callback` only when `value` is truthy, passing it the value; `otherwise` runs when it is not. */
  when<V>(
    value: V,
    callback: (query: ModelQuery<M>, value: Truthy<V>) => ModelQuery<M>,
    otherwise?: (query: ModelQuery<M>) => ModelQuery<M>
  ): ModelQuery<M> {
    if (value) return returned<M>(callback(this, value as Truthy<V>), "when()");
    return otherwise ? returned<M>(otherwise(this), "when()") : this;
  }

  // Global scopes and soft deletes

  /** Leaves out the global scopes with these names; soft deletes is "softDeletes". */
  withoutGlobalScope(...names: string[]): ModelQuery<M> {
    const { without } = this.#options;
    if (without === "all") return this;
    return this.#with(this.#builder, { without: new Set([...without, ...names]) });
  }

  /** Leaves out every global scope, or the ones named. */
  withoutGlobalScopes(names?: readonly string[]): ModelQuery<M> {
    return names ? this.withoutGlobalScope(...names) : this.#with(this.#builder, { without: "all" });
  }

  /** Includes soft-deleted rows. */
  withTrashed(): ModelQuery<M> {
    return this.withoutGlobalScope(SOFT_DELETES);
  }

  /** Only soft-deleted rows. */
  onlyTrashed(): ModelQuery<M> {
    if (!this.model.softDeletes) throw new Error(`Tenora: ${this.model.name} does not use soft deletes.`);
    return this.withoutGlobalScope(SOFT_DELETES).#with(this.#builder, { onlyTrashed: true });
  }

  /**
   * The underlying query builder with the global scopes applied, as it runs: for a subquery, or to read rows
   * without turning them into models.
   */
  toBase(): QueryBuilder {
    const model = this.model;
    const { without, onlyTrashed } = this.#options;
    const removed = (name: string) => without === "all" || without.has(name);
    const scopes = [...globalScopesOf(model, model.globalScopes)].filter(([name]) => !removed(name));
    const softDeletes = model.softDeletes && (onlyTrashed || !removed(SOFT_DELETES));
    if (!scopes.length && !softDeletes) return this.#builder;
    // Scopes see an unscoped query, so a scope that queries its own model does not apply itself again.
    let query = this.#with(groupWheres(this.#builder, 0), { without: "all", onlyTrashed: false });
    for (const [name, scope] of scopes) {
      const from = query.#builder.selectState.wheres.length;
      const scoped = returned<M>(scope(query), `global scope "${name}"`);
      query = query.#with(groupWheres(scoped.#builder, from));
    }
    if (!softDeletes) return query.#builder;
    const column = this.#qualified(model.DELETED_AT);
    return onlyTrashed ? query.#builder.whereNotNull(column) : query.#builder.whereNull(column);
  }

  /** The SQL and parameters this query would run, with its global scopes. */
  toSql(): CompiledQuery {
    return this.toBase().toSql();
  }

  // Filtering

  #where(method: "where" | "orWhere", args: unknown[]): ModelQuery<M> {
    const [first] = args;
    const where = this.#builder[method] as (...args: unknown[]) => QueryBuilder;
    if (typeof first === "function") {
      return this.#with(
        where.call(this.#builder, (inner: QueryBuilder) => {
          const nested = new ModelQuery(this.model, inner, { ...this.#options, without: "all", onlyTrashed: false });
          return returned<M>((first as Scope<M>)(nested), `${method}()`).#builder;
        })
      );
    }
    if (first !== null && typeof first === "object" && !(first instanceof RawSql)) {
      // { email, active: true }: every attribute equal, as one group.
      const entries = Object.entries(first);
      if (!entries.length) return this;
      return this.#with(
        where.call(this.#builder, (inner: QueryBuilder) =>
          entries.reduce((query, [key, value]) => query.where(this.#col(key), value as any), inner)
        )
      );
    }
    if (typeof first !== "string") throw new Error(`Tenora: ${method}() needs a column, an object of attributes or a callback.`);
    return this.#with(where.call(this.#builder, this.#col(first), ...args.slice(1).map(toOperand)));
  }

  /**
   * `where("name", "ada")`, `where("votes", ">", 100)`, `where({ name: "ada", active: true })`, or a callback for a
   * group in parentheses: `where((q) => q.where("a", 1).orWhere("b", 2))`. Attribute names are mapped to columns.
   */
  where(callback: (query: ModelQuery<M>) => ModelQuery<M>): ModelQuery<M>;
  where(attributes: Attributes<M>): ModelQuery<M>;
  where<K extends ColumnOf<M>>(column: K, value: WhereValue<M, K>): ModelQuery<M>;
  where<K extends ColumnOf<M>>(column: K, operator: Op, value: WhereValue<M, K>): ModelQuery<M>;
  where(...args: unknown[]): ModelQuery<M> {
    return this.#where("where", args);
  }

  orWhere(callback: (query: ModelQuery<M>) => ModelQuery<M>): ModelQuery<M>;
  orWhere(attributes: Attributes<M>): ModelQuery<M>;
  orWhere<K extends ColumnOf<M>>(column: K, value: WhereValue<M, K>): ModelQuery<M>;
  orWhere<K extends ColumnOf<M>>(column: K, operator: Op, value: WhereValue<M, K>): ModelQuery<M>;
  orWhere(...args: unknown[]): ModelQuery<M> {
    return this.#where("orWhere", args);
  }

  #columns(args: unknown[]): unknown[] {
    return args.length === 2
      ? [this.#col(String(args[0])), this.#col(String(args[1]))]
      : [this.#col(String(args[0])), args[1], this.#col(String(args[2]))];
  }

  whereColumn(first: ColumnOf<M>, second: ColumnOf<M>): ModelQuery<M>;
  whereColumn(first: ColumnOf<M>, operator: Op, second: ColumnOf<M>): ModelQuery<M>;
  whereColumn(...args: unknown[]): ModelQuery<M> {
    return this.#with((this.#builder.whereColumn as (...args: unknown[]) => QueryBuilder).call(this.#builder, ...this.#columns(args)));
  }

  orWhereColumn(first: ColumnOf<M>, second: ColumnOf<M>): ModelQuery<M>;
  orWhereColumn(first: ColumnOf<M>, operator: Op, second: ColumnOf<M>): ModelQuery<M>;
  orWhereColumn(...args: unknown[]): ModelQuery<M> {
    return this.#with((this.#builder.orWhereColumn as (...args: unknown[]) => QueryBuilder).call(this.#builder, ...this.#columns(args)));
  }

  #in(method: "whereIn" | "whereNotIn" | "orWhereIn" | "orWhereNotIn", column: string, values: readonly unknown[] | Subquery) {
    const list = values instanceof ModelQuery ? values.toBase() : (values as readonly unknown[] | QueryBuilder<any>);
    return this.#with(this.#builder[method](this.#col(column), list));
  }

  /** `whereIn("id", [1, 2])`, or a subquery: `whereIn("teamId", Team.query().select("id").where(...))`. */
  whereIn<K extends ColumnOf<M>>(column: K, values: readonly WhereValue<M, K>[] | Subquery): ModelQuery<M> {
    return this.#in("whereIn", column, values);
  }

  whereNotIn<K extends ColumnOf<M>>(column: K, values: readonly WhereValue<M, K>[] | Subquery): ModelQuery<M> {
    return this.#in("whereNotIn", column, values);
  }

  orWhereIn<K extends ColumnOf<M>>(column: K, values: readonly WhereValue<M, K>[] | Subquery): ModelQuery<M> {
    return this.#in("orWhereIn", column, values);
  }

  orWhereNotIn<K extends ColumnOf<M>>(column: K, values: readonly WhereValue<M, K>[] | Subquery): ModelQuery<M> {
    return this.#in("orWhereNotIn", column, values);
  }

  whereNull(column: ColumnOf<M>): ModelQuery<M> {
    return this.#with(this.#builder.whereNull(this.#col(column)));
  }

  whereNotNull(column: ColumnOf<M>): ModelQuery<M> {
    return this.#with(this.#builder.whereNotNull(this.#col(column)));
  }

  orWhereNull(column: ColumnOf<M>): ModelQuery<M> {
    return this.#with(this.#builder.orWhereNull(this.#col(column)));
  }

  orWhereNotNull(column: ColumnOf<M>): ModelQuery<M> {
    return this.#with(this.#builder.orWhereNotNull(this.#col(column)));
  }

  whereBetween<K extends ColumnOf<M>>(column: K, range: readonly [WhereValue<M, K>, WhereValue<M, K>]): ModelQuery<M> {
    return this.#with(this.#builder.whereBetween(this.#col(column), range));
  }

  whereNotBetween<K extends ColumnOf<M>>(column: K, range: readonly [WhereValue<M, K>, WhereValue<M, K>]): ModelQuery<M> {
    return this.#with(this.#builder.whereNotBetween(this.#col(column), range));
  }

  whereExists(query: Subquery): ModelQuery<M> {
    return this.#with(this.#builder.whereExists(toOperand(query) as QueryBuilder<any>));
  }

  whereNotExists(query: Subquery): ModelQuery<M> {
    return this.#with(this.#builder.whereNotExists(toOperand(query) as QueryBuilder<any>));
  }

  /** A raw condition; column names in it are the database's. */
  whereRaw(fragment: RawSql): ModelQuery<M> {
    return this.#with(this.#builder.whereRaw(fragment));
  }

  orWhereRaw(fragment: RawSql): ModelQuery<M> {
    return this.#with(this.#builder.orWhereRaw(fragment));
  }

  /** The model with this key, or any of these keys. */
  whereKey(id: unknown): ModelQuery<M> {
    const column = this.#qualified(this.model.primaryKey);
    return this.#with(
      Array.isArray(id) ? this.#builder.whereIn(column, id) : this.#builder.where(column, id as any)
    );
  }

  whereKeyNot(id: unknown): ModelQuery<M> {
    const column = this.#qualified(this.model.primaryKey);
    return this.#with(
      Array.isArray(id) ? this.#builder.whereNotIn(column, id) : this.#builder.where(column, "!=", id as any)
    );
  }

  // Selecting, joining, grouping

  /** Columns to select. A model loaded with some columns has only those attributes. */
  select(...columns: (ColumnOf<M> | "*")[]): ModelQuery<M> {
    return this.#with(this.#builder.select(...columns.map((column) => this.#col(column))));
  }

  selectRaw(fragment: RawSql): ModelQuery<M> {
    return this.#with(this.#builder.selectRaw(fragment));
  }

  selectSub(query: Subquery, alias: string): ModelQuery<M> {
    return this.#with(this.#builder.selectSub(toOperand(query) as QueryBuilder<any>, alias));
  }

  distinct(): ModelQuery<M> {
    return this.#with(this.#builder.distinct());
  }

  #joinArgs(args: JoinArgs): JoinArgs {
    return typeof args[0] === "function" ? args : (this.#columns(args) as JoinArgs);
  }

  /** A join; its columns can be qualified attribute names. In a join callback, write the database's column names. */
  join(table: string, ...args: JoinArgs): ModelQuery<M> {
    return this.#with(this.#builder.join(table, ...this.#joinArgs(args)));
  }

  leftJoin(table: string, ...args: JoinArgs): ModelQuery<M> {
    return this.#with(this.#builder.leftJoin(table, ...this.#joinArgs(args)));
  }

  rightJoin(table: string, ...args: JoinArgs): ModelQuery<M> {
    return this.#with(this.#builder.rightJoin(table, ...this.#joinArgs(args)));
  }

  crossJoin(table: string): ModelQuery<M> {
    return this.#with(this.#builder.crossJoin(table));
  }

  joinSub(query: Subquery, alias: string, ...args: JoinArgs): ModelQuery<M> {
    return this.#with(this.#builder.joinSub(toOperand(query) as QueryBuilder<any>, alias, ...this.#joinArgs(args)));
  }

  leftJoinSub(query: Subquery, alias: string, ...args: JoinArgs): ModelQuery<M> {
    return this.#with(this.#builder.leftJoinSub(toOperand(query) as QueryBuilder<any>, alias, ...this.#joinArgs(args)));
  }

  groupBy(...columns: ColumnOf<M>[]): ModelQuery<M> {
    return this.#with(this.#builder.groupBy(...columns.map((column) => this.#col(column))));
  }

  having(column: string, value: unknown): ModelQuery<M>;
  having(column: string, operator: Op, value: unknown): ModelQuery<M>;
  having(column: string, ...rest: unknown[]): ModelQuery<M> {
    return this.#with((this.#builder.having as (...args: unknown[]) => QueryBuilder).call(this.#builder, this.#col(column), ...rest));
  }

  orHaving(column: string, value: unknown): ModelQuery<M>;
  orHaving(column: string, operator: Op, value: unknown): ModelQuery<M>;
  orHaving(column: string, ...rest: unknown[]): ModelQuery<M> {
    return this.#with((this.#builder.orHaving as (...args: unknown[]) => QueryBuilder).call(this.#builder, this.#col(column), ...rest));
  }

  havingRaw(fragment: RawSql): ModelQuery<M> {
    return this.#with(this.#builder.havingRaw(fragment));
  }

  // Ordering, paging, combining, locking

  orderBy(column: ColumnOf<M> | RawSql, direction?: "asc" | "desc"): ModelQuery<M> {
    return this.#with(this.#builder.orderBy(column instanceof RawSql ? column : this.#col(column), direction));
  }

  orderByDesc(column: ColumnOf<M>): ModelQuery<M> {
    return this.orderBy(column, "desc");
  }

  orderByRaw(fragment: RawSql): ModelQuery<M> {
    return this.#with(this.#builder.orderByRaw(fragment));
  }

  /** Newest first, by createdAt unless another column is named. */
  latest(column?: ColumnOf<M>): ModelQuery<M> {
    return this.orderBy(column ?? ((this.model.CREATED_AT ?? "createdAt") as ColumnOf<M>), "desc");
  }

  oldest(column?: ColumnOf<M>): ModelQuery<M> {
    return this.orderBy(column ?? ((this.model.CREATED_AT ?? "createdAt") as ColumnOf<M>), "asc");
  }

  inRandomOrder(): ModelQuery<M> {
    return this.#with(this.#builder.inRandomOrder());
  }

  limit(count: number): ModelQuery<M> {
    return this.#with(this.#builder.limit(count));
  }

  offset(count: number): ModelQuery<M> {
    return this.#with(this.#builder.offset(count));
  }

  forPage(page: number, perPage = this.model.perPage): ModelQuery<M> {
    return this.#with(this.#builder.forPage(page, perPage));
  }

  union(query: Subquery): ModelQuery<M> {
    return this.#with(this.#builder.union(toOperand(query) as QueryBuilder<any>));
  }

  unionAll(query: Subquery): ModelQuery<M> {
    return this.#with(this.#builder.unionAll(toOperand(query) as QueryBuilder<any>));
  }

  forUpdate(): ModelQuery<M> {
    return this.#with(this.#builder.forUpdate());
  }

  sharedLock(): ModelQuery<M> {
    return this.#with(this.#builder.sharedLock());
  }

  skipLocked(): ModelQuery<M> {
    return this.#with(this.#builder.skipLocked());
  }

  // Reading

  async #hydrate(rows: Record<string, unknown>[]): Promise<M[]> {
    const connection = this.connection;
    const models = rows.map((row) => internals.hydrate(this.model, row, connection));
    if (models.length && hasListeners(this.model, "retrieved")) {
      for (const model of models) await fire(model, "retrieved", connection);
    }
    return models;
  }

  /** The matching models. Fires retrieved for each. */
  async get(): Promise<M[]> {
    const builder = this.toBase();
    return this.#run(async () => this.#hydrate(await builder.get()));
  }

  then<A = M[], B = never>(
    onfulfilled?: ((models: M[]) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return this.get().then(onfulfilled, onrejected);
  }

  async first(): Promise<M | undefined> {
    const [model] = await this.limit(1).get();
    return model;
  }

  async firstOrFail(): Promise<M> {
    const model = await this.first();
    if (!model) throw new ModelNotFoundError(this.model.name);
    return model;
  }

  /** The model with this key, or the models with these keys. */
  find(id: unknown): Promise<M | undefined>;
  find(ids: readonly unknown[]): Promise<M[]>;
  find(id: unknown): Promise<M | undefined | M[]> {
    if (Array.isArray(id)) return this.findMany(id);
    return this.#grouped().whereKey(id).first();
  }

  /** Like find(), but throws ModelNotFoundError when a key has no model. */
  findOrFail(id: unknown): Promise<M>;
  findOrFail(ids: readonly unknown[]): Promise<M[]>;
  async findOrFail(id: unknown): Promise<M | M[]> {
    if (Array.isArray(id)) {
      const models = await this.findMany(id);
      const found = new Set(models.map((model) => String(model.getKey())));
      const missing = [...new Set(id)].filter((key) => !found.has(String(key)));
      if (missing.length) throw new ModelNotFoundError(this.model.name, missing);
      return models;
    }
    const model = await this.find(id);
    if (!model) throw new ModelNotFoundError(this.model.name, [id]);
    return model;
  }

  async findMany(ids: readonly unknown[]): Promise<M[]> {
    if (!ids.length) return [];
    return this.#grouped().whereKey([...ids]).get();
  }

  async count(column: ColumnOf<M> | "*" = "*"): Promise<number> {
    const builder = this.toBase();
    return this.#run(() => builder.count(this.#col(column)));
  }

  async exists(): Promise<boolean> {
    const builder = this.toBase();
    return this.#run(() => builder.exists());
  }

  async doesntExist(): Promise<boolean> {
    return !(await this.exists());
  }

  async sum(column: ColumnOf<M>): Promise<number | null> {
    const builder = this.toBase();
    return this.#run(() => builder.sum(this.#col(column)));
  }

  async avg(column: ColumnOf<M>): Promise<number | null> {
    const builder = this.toBase();
    return this.#run(() => builder.avg(this.#col(column)));
  }

  async min<K extends ColumnOf<M>>(column: K): Promise<ValueOf<M, K> | undefined> {
    const builder = this.toBase();
    return this.#run(() => builder.min<ValueOf<M, K>>(this.#col(column)));
  }

  async max<K extends ColumnOf<M>>(column: K): Promise<ValueOf<M, K> | undefined> {
    const builder = this.toBase();
    return this.#run(() => builder.max<ValueOf<M, K>>(this.#col(column)));
  }

  /** One attribute of every matching row, through its cast. */
  async pluck<K extends ColumnOf<M>>(column: K): Promise<ValueOf<M, K>[]> {
    const builder = this.toBase();
    const values = await this.#run(() => builder.pluck(this.#col(column)));
    const meta = this.#meta;
    const unqualified = column.startsWith(`${meta.table}.`) ? column.slice(meta.table.length + 1) : column;
    const cast = meta.casts.get(unqualified);
    return (cast ? values.map((value) => cast.get(value)) : values) as ValueOf<M, K>[];
  }

  /** One attribute of the first matching row, through its cast. */
  async value<K extends ColumnOf<M>>(column: K): Promise<ValueOf<M, K> | undefined> {
    const [value] = await this.limit(1).pluck(column);
    return value;
  }

  /** One page of models and the total count: `{ data, total, page, perPage, lastPage }`. Pages count from 1. */
  async paginate({ page = 1, perPage = this.model.perPage }: { page?: number; perPage?: number } = {}): Promise<Page<M>> {
    if (!Number.isInteger(page) || page < 1) throw new Error("Tenora: paginate() counts pages from 1.");
    if (!Number.isInteger(perPage) || perPage < 1) throw new Error("Tenora: paginate() needs a perPage of 1 or more.");
    const total = await this.count();
    const data = total > (page - 1) * perPage ? await this.forPage(page, perPage).get() : [];
    return { data, total, page, perPage, lastPage: Math.max(1, Math.ceil(total / perPage)) };
  }

  /**
   * Pages through the matching models in key order, `count` at a time, reading each page after the last key of the
   * one before, so rows changed or deleted along the way do not shift the pages.
   */
  async *#chunks(count: number, method: string): AsyncGenerator<M[], void, undefined> {
    if (!Number.isInteger(count) || count < 1) throw new Error(`Tenora: ${method}() needs a chunk size of 1 or more.`);
    const { orders, limit, offset } = this.#builder.selectState;
    if (orders.length || limit !== undefined || offset !== undefined) {
      throw new Error(`Tenora: ${method}() orders and pages by the key itself; remove orderBy(), limit() and offset().`);
    }
    const key = this.model.primaryKey;
    const column = this.#qualified(key);
    const base = this.#grouped();
    let last: unknown;
    for (;;) {
      const after = last === undefined ? base.#builder : base.#builder.where(column, ">", last as any);
      const models = await base.#with(after.orderBy(column).limit(count)).get();
      if (models.length) yield models;
      if (models.length < count) return;
      last = (models[models.length - 1] as any)[key];
      if (last === undefined || last === null) throw new Error(`Tenora: ${method}() needs every row's ${key}; select it.`);
    }
  }

  /** Calls `callback` with each chunk of models in key order. Returning false stops; then this returns false. */
  async chunkById(count: number, callback: (models: M[], page: number) => unknown): Promise<boolean> {
    let page = 0;
    for await (const models of this.#chunks(count, "chunkById")) {
      if ((await callback(models, ++page)) === false) return false;
    }
    return true;
  }

  /** The matching models one at a time, read in chunks in key order: `for await (const user of query.lazyById())`. */
  async *lazyById(count = 1000): AsyncGenerator<M, void, undefined> {
    for await (const models of this.#chunks(count, "lazyById")) yield* models;
  }

  // Mass writes: one statement for every matching row, without loading models or firing their events.

  #columnValues(values: Record<string, unknown>): Record<string, unknown> {
    const meta = this.#meta;
    const columns: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const cast = meta.casts.get(key);
      columns[this.#col(key)] = cast && !(value instanceof RawSql) ? cast.set(value) : value;
    }
    return columns;
  }

  #withUpdatedAt(columns: Record<string, unknown>, given: object): Record<string, unknown> {
    const { timestamps, UPDATED_AT } = this.model;
    if (!timestamps || !UPDATED_AT || UPDATED_AT in given) return columns;
    return { ...columns, [this.#meta.columnOf(UPDATED_AT)]: freshTimestamp() };
  }

  /** Updates every matching row, setting updatedAt too, and returns how many changed. Fires no model events. */
  async update(values: UpdateValues<M>): Promise<number> {
    const columns = this.#withUpdatedAt(this.#columnValues(values), values);
    const builder = this.toBase();
    return this.#run(() => builder.update(columns));
  }

  increment(column: AttributeName<M>, amount = 1, extra: UpdateValues<M> = {}): Promise<number> {
    const columns = this.#withUpdatedAt(this.#columnValues(extra), extra);
    const builder = this.toBase();
    return this.#run(() => builder.increment(this.#col(column), amount, columns));
  }

  decrement(column: AttributeName<M>, amount = 1, extra: UpdateValues<M> = {}): Promise<number> {
    const columns = this.#withUpdatedAt(this.#columnValues(extra), extra);
    const builder = this.toBase();
    return this.#run(() => builder.decrement(this.#col(column), amount, columns));
  }

  /**
   * Deletes every matching row, or with soft deletes sets their deletedAt, and returns how many. Fires no model
   * events; load the models and delete each for those.
   */
  async delete(): Promise<number> {
    const model = this.model;
    if (!model.softDeletes) {
      const builder = this.toBase();
      return this.#run(() => builder.delete());
    }
    const now = freshTimestamp();
    const columns: Record<string, unknown> = { [this.#meta.columnOf(model.DELETED_AT)]: now };
    if (model.timestamps && model.UPDATED_AT) columns[this.#meta.columnOf(model.UPDATED_AT)] = now;
    const builder = this.toBase();
    return this.#run(() => builder.update(columns));
  }

  /** Deletes every matching row, soft-deleted or not, without model events. */
  async forceDelete(): Promise<number> {
    const builder = this.withTrashed().toBase();
    return this.#run(() => builder.delete());
  }

  /** Restores every matching soft-deleted row, without model events. */
  async restore(): Promise<number> {
    if (!this.model.softDeletes) throw new Error(`Tenora: ${this.model.name} does not use soft deletes.`);
    return this.withTrashed().update({ [this.model.DELETED_AT]: null } as UpdateValues<M>);
  }

  /**
   * Inserts rows, or updates the ones whose unique key already exists, with createdAt and updatedAt set. `update`
   * defaults to every attribute except the unique key and createdAt. Fires no model events.
   */
  async upsert(
    values: Attributes<M> | readonly Attributes<M>[],
    uniqueBy: AttributeName<M> | readonly AttributeName<M>[],
    update?: readonly AttributeName<M>[]
  ): Promise<number> {
    const list = (Array.isArray(values) ? values : [values]) as Record<string, unknown>[];
    if (!list.length) return 0;
    const { timestamps, CREATED_AT, UPDATED_AT } = this.model;
    const now = freshTimestamp();
    const stamped = timestamps ? [CREATED_AT, UPDATED_AT].filter((name): name is string => !!name) : [];
    const rows = list.map((row) => {
      const withTimes = { ...row };
      for (const name of stamped) if (withTimes[name] === undefined) withTimes[name] = now;
      return this.#columnValues(withTimes);
    });
    const unique = (Array.isArray(uniqueBy) ? uniqueBy : [uniqueBy]) as string[];
    const updated = update
      ? [...update, ...(update.length && timestamps && UPDATED_AT && !update.includes(UPDATED_AT as never) ? [UPDATED_AT] : [])]
      : Object.keys({ ...list[0], ...Object.fromEntries(stamped.map((name) => [name, true])) }).filter(
          (name) => !unique.includes(name) && name !== CREATED_AT
        );
    const builder = this.#builder;
    return this.#run(() =>
      builder.upsert(
        rows,
        unique.map((name) => this.#col(name)),
        updated.map((name) => this.#col(name))
      )
    );
  }

  // Creating

  /** A new, unsaved model filled with `attributes`, which saves to this query's connection. */
  make(attributes: Attributes<M> = {}): M {
    const model = new this.model();
    model.fill(attributes as Attributes<M>);
    internals.bind(model, this.connection);
    return model;
  }

  async #create(attributes: Attributes<M>): Promise<M> {
    const model = this.make(attributes);
    await model.save();
    return model;
  }

  /** Fills a new model and saves it; on this query's connection and transaction. */
  create(attributes: Attributes<M> = {}): Promise<M> {
    return this.#run(() => this.#create(attributes));
  }

  /** The first model matching `attributes`, or a new unsaved one filled with them and `values`. */
  async firstOrNew(attributes: Attributes<M>, values: Attributes<M> = {}): Promise<M> {
    return (await this.#grouped().where(attributes).first()) ?? this.make({ ...attributes, ...values });
  }

  /** The first model matching `attributes`, or one created with them and `values` (through createOrFirst). */
  async firstOrCreate(attributes: Attributes<M>, values: Attributes<M> = {}): Promise<M> {
    return (await this.#grouped().where(attributes).first()) ?? this.createOrFirst(attributes, values);
  }

  /**
   * Creates the model, or returns the existing one when a unique key already holds it: for rows that two requests
   * may create at once. The insert runs in a transaction, a savepoint inside an open one, so the unique violation
   * does not abort the surrounding transaction on Postgres.
   */
  async createOrFirst(attributes: Attributes<M>, values: Attributes<M> = {}): Promise<M> {
    try {
      return await this.#run(() => this.connection.transaction(() => this.#create({ ...attributes, ...values })));
    } catch (error) {
      if (!(error instanceof QueryError) || error.kind !== "unique_violation") throw error;
      const existing = await this.#grouped().where(attributes).first();
      if (!existing) throw error;
      return existing;
    }
  }

  /** Updates the first model matching `attributes` with `values`, or creates it with both. */
  async updateOrCreate(attributes: Attributes<M>, values: Attributes<M> = {}): Promise<M> {
    const model = await this.firstOrCreate(attributes, values);
    if (!model.wasRecentlyCreated) {
      model.fill(values as Attributes<M>);
      await this.#run(() => model.save());
    }
    return model;
  }
}
