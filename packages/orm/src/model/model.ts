import type { Connection, Transaction } from "../connection";
import type { Operator } from "../query/state";
import type { QueryBuilder } from "../query/builder";
import { type AttributeCast, type CastDefinition, DATETIME_CAST, fingerprint, resolveCast, snapshot } from "./casts";
import { resolveConnection } from "./connections";
import { MassAssignmentError, ModelNotFoundError, RelationNotLoadedError } from "./errors";
import {
  type EventListener,
  fire,
  forget,
  listen,
  type ListenerOptions,
  observe,
  type Observer,
  type ObserverClass,
} from "./events";
import { defaultTableName, naming, type NamingStrategy } from "./naming";
import { ModelQuery } from "./query";
import { addGlobalScope, type Scope } from "./scope";
import type {
  AttributeName,
  Attributes,
  ColumnOf,
  Fields,
  ModelClass,
  Page,
  ValueOf,
  WhereValue,
} from "./types";

type Op = Operator | (string & {});

/** @internal What a model class's static configuration works out to. Computed on first use, then cached. */
export type ModelMeta = {
  readonly table: string;
  readonly naming: NamingStrategy;
  readonly primaryColumn: string;
  readonly casts: ReadonlyMap<string, AttributeCast>;
  columnOf(attribute: string): string;
  attributeOf(column: string): string;
  /** throws when an attribute of that name would hide one of the model's methods or getters */
  assertAssignable(attribute: string): void;
};

const metas = new WeakMap<Function, ModelMeta>();

const createMeta = (model: ModelClass): ModelMeta => {
  const strategy = model.naming;
  const casts = new Map<string, AttributeCast>();
  for (const [attribute, definition] of Object.entries(model.casts ?? {})) {
    casts.set(attribute, resolveCast(definition, `${model.name}.${attribute}`));
  }
  // Timestamps are dates without a declared cast too; SQLite would otherwise return them as numbers.
  const dates = [
    model.timestamps ? model.CREATED_AT : null,
    model.timestamps ? model.UPDATED_AT : null,
    model.softDeletes ? model.DELETED_AT : null,
  ];
  for (const attribute of dates) if (attribute && !casts.has(attribute)) casts.set(attribute, DATETIME_CAST);

  const columns = new Map<string, string>();
  const attributes = new Map<string, string>();
  const assignable = new Set<string>();
  const columnOf = (attribute: string) => {
    let column = columns.get(attribute);
    if (column === undefined) columns.set(attribute, (column = strategy.toColumn(attribute)));
    return column;
  };
  return {
    table: model.table ?? defaultTableName(model.name),
    naming: strategy,
    primaryColumn: columnOf(model.primaryKey),
    casts,
    columnOf,
    attributeOf(column) {
      let attribute = attributes.get(column);
      if (attribute === undefined) {
        attributes.set(column, (attribute = strategy.toAttribute(column)));
        // A column the strategy would not map back to ("UserName" → "user_name") keeps the name it was read from.
        if (columnOf(attribute) !== column) columns.set(attribute, column);
      }
      return attribute;
    },
    assertAssignable(attribute) {
      if (assignable.has(attribute)) return;
      if (attribute in model.prototype) {
        throw new Error(
          `Tenora: "${attribute}" cannot be an attribute of ${model.name}, because ${model.name} has a method or getter of that name. Rename one of them, or select the column under another name.`
        );
      }
      assignable.add(attribute);
    },
  };
};

/** @internal */
export const metaOf = (model: ModelClass): ModelMeta => {
  let meta = metas.get(model);
  if (!meta) metas.set(model, (meta = createMeta(model)));
  return meta;
};

/** @internal Whole seconds, as Laravel stores them, so the value in memory is the one every column type keeps. */
export const freshTimestamp = () => new Date(Math.floor(Date.now() / 1000) * 1000);

/** @internal The parts of a model's private state that ModelQuery needs. */
export const internals = {} as {
  hydrate<M extends Model>(model: ModelClass<M>, row: Record<string, unknown>, connection: Connection): M;
  bind(model: Model, connection: Connection): void;
};

/** A query of a model on the connection its declared name resolves to. */
const queryOf = <M extends Model>(model: ModelClass<M>): ModelQuery<M> => ModelQuery.create(model, resolveConnection(model));

const isFillable = (model: typeof Model, key: string) => {
  if (model.fillable.includes(key)) return true;
  if (model.guarded.length && (model.guarded.includes("*") || model.guarded.includes(key))) return false;
  return model.fillable.length === 0 && !key.startsWith("_");
};

const toArray = (value: unknown): unknown =>
  value instanceof Model ? value.toJSON() : Array.isArray(value) ? value.map(toArray) : value;

/**
 * A row of a table as an object. Attributes are the instance's own properties, declared with `declare` so that class
 * fields do not reset them:
 *
 * ```ts
 * class User extends Model {
 *   static fillable = ["name", "email"];
 *   declare id: number;
 *   declare name: string;
 * }
 * ```
 *
 * Every own enumerable property is an attribute and is saved as a column; keep other state in `#private` fields.
 */
export class Model {
  /** the table; by default the snake_case plural of the class name ("OrderItem" → "order_items") */
  static table?: string;
  /** the attribute holding the primary key */
  static primaryKey = "id";
  /** whether the database generates the key; an insert without one reads it back */
  static incrementing = true;
  /** the name the connection resolver gets: "tenant", "base", … */
  static connection = "default";
  /** attributes `fill()` and `create()` may set; the rest are guarded */
  static fillable: readonly string[] = [];
  /** attributes `fill()` may not set; ["*"] (the default) guards every attribute not in `fillable` */
  static guarded: readonly string[] = ["*"];
  /** attributes left out of `toJSON()` */
  static hidden: readonly string[] = [];
  /** when not empty, the only attributes `toJSON()` includes */
  static visible: readonly string[] = [];
  /** getters `toJSON()` adds */
  static appends: readonly string[] = [];
  /** how attributes are read and written: "boolean", "integer", "float", "string", "json", "datetime", "date", cast.json<T>() or { get, set } */
  static casts: Readonly<Record<string, CastDefinition>> = {};
  /** set createdAt on insert and updatedAt on every save */
  static timestamps = true;
  static CREATED_AT: string | null = "createdAt";
  static UPDATED_AT: string | null = "updatedAt";
  /** delete by setting deletedAt; queries leave those rows out unless asked with withTrashed() or onlyTrashed() */
  static softDeletes = false;
  static DELETED_AT = "deletedAt";
  /** how attribute names map to columns; naming.none uses the column names as they are */
  static naming: NamingStrategy = naming.snakeCase;
  /** refuse what Eloquent lets pass silently: fill() dropping a guarded key, reading a relation that was not loaded */
  static strict = true;
  /** the page size of paginate() when none is given */
  static perPage = 15;
  /** scopes applied to every query of the model, by name: { active: (query) => query.where("active", true) } */
  static globalScopes: Readonly<Record<string, Scope<any>>> = {};

  #exists = false;
  #recentlyCreated = false;
  #original: Record<string, unknown> = Object.create(null);
  #changes: Record<string, unknown> = Object.create(null);
  #connection: Connection | undefined;
  #transaction: Transaction | undefined;
  // Relations are kept here, not as properties, so they are never mistaken for columns.
  #relations = new Map<string, unknown>();

  /** A new, unsaved model; `attributes` go through `fill()`. */
  constructor(attributes?: Record<string, unknown>) {
    if (attributes) this.fill(attributes as Attributes<this>);
  }

  static {
    internals.hydrate = (model, row, connection) => {
      const instance = new model();
      const meta = metaOf(model);
      for (const column of Object.keys(row)) {
        const attribute = meta.attributeOf(column);
        meta.assertAssignable(attribute);
        const cast = meta.casts.get(attribute);
        (instance as any)[attribute] = cast ? cast.get(row[column]) : row[column];
      }
      instance.#exists = true;
      instance.#connection = connection;
      instance.#syncOriginal();
      return instance;
    };
    internals.bind = (instance, connection) => {
      instance.#connection = connection;
    };
  }

  get #model(): typeof Model {
    return this.constructor as typeof Model;
  }

  get #meta(): ModelMeta {
    return metaOf(this.#model);
  }

  /** True once the model was saved or loaded, until it is deleted (a soft delete keeps it). */
  get exists(): boolean {
    return this.#exists;
  }

  /** True when the last save inserted the model. */
  get wasRecentlyCreated(): boolean {
    return this.#recentlyCreated;
  }

  getKey(): unknown {
    return (this as any)[this.#model.primaryKey];
  }

  /** A copy of the attributes. */
  getAttributes(): Attributes<this> {
    return { ...this } as Attributes<this>;
  }

  #assign(key: string, value: unknown) {
    this.#meta.assertAssignable(key);
    (this as any)[key] = value;
  }

  /**
   * Sets the attributes that `fillable` and `guarded` allow. A key they do not allow is dropped, or, in strict mode
   * (the default), throws, so a typo or an unexpected request field does not go unnoticed.
   */
  fill(attributes: Attributes<this>): this {
    const model = this.#model;
    const totallyGuarded = model.fillable.length === 0 && model.guarded.includes("*");
    for (const [key, value] of Object.entries(attributes)) {
      if (isFillable(model, key)) this.#assign(key, value);
      else if (totallyGuarded) {
        throw new MassAssignmentError(
          `Tenora: ${model.name} allows no mass assignment, so "${key}" cannot be filled. List the attributes fill() and create() may set in ${model.name}.fillable, or set guarded = [] to allow all.`
        );
      } else if (model.strict) {
        throw new MassAssignmentError(
          `Tenora: "${key}" is not fillable on ${model.name}, and strict mode does not drop it silently. Add it to ${model.name}.fillable, assign it directly, or use forceFill().`
        );
      }
    }
    return this;
  }

  /** Sets attributes without checking `fillable` and `guarded`. */
  forceFill(attributes: Attributes<this>): this {
    for (const [key, value] of Object.entries(attributes)) this.#assign(key, value);
    return this;
  }

  // Changes

  #syncOriginal() {
    this.#original = Object.create(null);
    for (const key of Object.keys(this)) this.#original[key] = snapshot((this as any)[key]);
  }

  /** Attributes whose value differs from the one last read or saved; undefined counts as not set. */
  #dirtyKeys(): string[] {
    const { casts } = this.#meta;
    return Object.keys(this).filter((key) => {
      const value = (this as any)[key];
      if (value === undefined) return false;
      if (!(key in this.#original)) return true;
      const cast = casts.get(key);
      return fingerprint(cast, value) !== fingerprint(cast, this.#original[key]);
    });
  }

  /** The attributes changed since the model was read or saved, with their new values. */
  getDirty(): Attributes<this> {
    return Object.fromEntries(this.#dirtyKeys().map((key) => [key, (this as any)[key]])) as Attributes<this>;
  }

  /** Whether any attribute (or one of those named) changed since the model was read or saved. */
  isDirty(attributes?: AttributeName<this> | readonly AttributeName<this>[]): boolean {
    const dirty = this.#dirtyKeys();
    if (attributes === undefined) return dirty.length > 0;
    const names: readonly string[] = typeof attributes === "string" ? [attributes] : attributes;
    return names.some((name) => dirty.includes(name));
  }

  isClean(attributes?: AttributeName<this> | readonly AttributeName<this>[]): boolean {
    return !this.isDirty(attributes);
  }

  /** The value an attribute had when the model was read or last saved, or all of them. */
  getOriginal(): Attributes<this>;
  getOriginal<K extends AttributeName<this>>(attribute: K): Fields<this>[K] | undefined;
  getOriginal(attribute?: string): unknown {
    if (attribute !== undefined) return snapshot(this.#original[attribute]);
    return Object.fromEntries(Object.entries(this.#original).map(([key, value]) => [key, snapshot(value)]));
  }

  /** The attributes the last save changed, with the values it wrote. */
  getChanges(): Attributes<this> {
    return { ...this.#changes } as Attributes<this>;
  }

  /** Whether the last save changed any attribute, or one of those named. */
  wasChanged(attributes?: AttributeName<this> | readonly AttributeName<this>[]): boolean {
    const changed = Object.keys(this.#changes);
    if (attributes === undefined) return changed.length > 0;
    const names: readonly string[] = typeof attributes === "string" ? [attributes] : attributes;
    return names.some((name) => changed.includes(name));
  }

  // Writing

  /**
   * Runs `fn` where this model's writes go: in the transaction pinned with `using(trx)`, which events then join too;
   * otherwise on the database the model was loaded from or saved to, or its declared connection, in whatever
   * transaction is open there.
   */
  #run<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const transaction = this.#transaction;
    if (transaction) return transaction.run(() => fn(transaction.connection));
    try {
      return fn(this.#connection ?? resolveConnection(this.#model as ModelClass));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** The key the row was read with, which is the one to update or delete by even if the key attribute changed. */
  #originalKey(): unknown {
    const key = this.#model.primaryKey;
    const value = key in this.#original ? this.#original[key] : (this as any)[key];
    if (value === undefined || value === null) {
      throw new Error(`Tenora: this ${this.#model.name} has no ${key}, so its row cannot be found.`);
    }
    return value;
  }

  #byKey(connection: Connection): QueryBuilder {
    const meta = this.#meta;
    return connection.table(meta.table).where(meta.primaryColumn, this.#originalKey() as any);
  }

  /** Column values to write for these attributes, through their casts. */
  #columnValues(keys: readonly string[]): Record<string, unknown> {
    const { casts, columnOf } = this.#meta;
    const values: Record<string, unknown> = {};
    for (const key of keys) {
      const value = (this as any)[key];
      if (value === undefined) continue;
      const cast = casts.get(key);
      values[columnOf(key)] = cast ? cast.set(value) : value;
    }
    return values;
  }

  #touchTimestamps(now: Date) {
    const { CREATED_AT, UPDATED_AT } = this.#model;
    const dirty = this.#dirtyKeys();
    if (UPDATED_AT && !dirty.includes(UPDATED_AT)) this.#assign(UPDATED_AT, now);
    if (!this.#exists && CREATED_AT && !dirty.includes(CREATED_AT)) this.#assign(CREATED_AT, now);
  }

  /**
   * Inserts the model, or updates the columns that changed; does nothing when none did. Fires saving, creating or
   * updating (any of which can cancel by returning false), then created or updated, then saved. Returns false when
   * cancelled.
   */
  save(): Promise<boolean> {
    return this.#run(async (connection) => {
      if (!(await fire(this, "saving", connection))) return false;
      const saved = this.#exists
        ? this.isDirty()
          ? await this.#performUpdate(connection)
          : true
        : await this.#performInsert(connection);
      if (!saved) return false;
      this.#connection = connection;
      await fire(this, "saved", connection);
      this.#syncOriginal();
      return true;
    });
  }

  async #performInsert(connection: Connection): Promise<boolean> {
    if (!(await fire(this, "creating", connection))) return false;
    const model = this.#model;
    const meta = this.#meta;
    if (model.timestamps) this.#touchTimestamps(freshTimestamp());
    const key = model.primaryKey;
    const generated = model.incrementing && ((this as any)[key] === undefined || (this as any)[key] === null);
    const values = this.#columnValues(Object.keys(this).filter((name) => !(generated && name === key)));
    if (!Object.keys(values).length) throw new Error(`Tenora: this ${model.name} has no attributes to insert.`);
    const table = connection.table(meta.table);
    if (generated) {
      const id = await table.insertGetId(values, meta.primaryColumn);
      const cast = meta.casts.get(key);
      this.#assign(key, cast ? cast.get(id) : id);
    } else {
      await table.insert(values);
    }
    this.#exists = true;
    this.#recentlyCreated = true;
    this.#connection = connection;
    this.#changes = Object.create(null);
    await fire(this, "created", connection);
    return true;
  }

  async #performUpdate(connection: Connection): Promise<boolean> {
    if (!(await fire(this, "updating", connection))) return false;
    if (this.#model.timestamps) this.#touchTimestamps(freshTimestamp());
    const dirty = this.#dirtyKeys();
    if (dirty.length) {
      await this.#byKey(connection).update(this.#columnValues(dirty));
      this.#changes = Object.create(null);
      for (const key of dirty) this.#changes[key] = snapshot((this as any)[key]);
      await fire(this, "updated", connection);
    }
    return true;
  }

  /** `fill(attributes)`, then `save()`. Returns false for a model that was never saved. */
  async update(attributes: Attributes<this>): Promise<boolean> {
    if (!this.#exists) return false;
    return this.fill(attributes).save();
  }

  /** Sets updatedAt (or the attribute named) to now and saves. */
  async touch(attribute?: AttributeName<this>): Promise<boolean> {
    const model = this.#model;
    if (attribute !== undefined) {
      this.#assign(attribute, freshTimestamp());
      return this.save();
    }
    if (!model.timestamps || !model.UPDATED_AT) return false;
    this.#assign(model.UPDATED_AT, freshTimestamp());
    return this.save();
  }

  /**
   * Deletes the row, or with soft deletes sets deletedAt. Fires deleting (which can cancel by returning false) and
   * deleted.
   */
  async delete(): Promise<boolean> {
    if (!this.#exists) return false;
    return this.#run((connection) => this.#performDelete(connection, !this.#model.softDeletes));
  }

  /** Deletes the row even with soft deletes, firing forceDeleting, deleting, deleted and forceDeleted. */
  async forceDelete(): Promise<boolean> {
    if (!this.#model.softDeletes) return this.delete();
    if (!this.#exists) return false;
    return this.#run(async (connection) => {
      if (!(await fire(this, "forceDeleting", connection))) return false;
      if (!(await this.#performDelete(connection, true))) return false;
      await fire(this, "forceDeleted", connection);
      return true;
    });
  }

  async #performDelete(connection: Connection, force: boolean): Promise<boolean> {
    if (!(await fire(this, "deleting", connection))) return false;
    if (force) {
      await this.#byKey(connection).delete();
      this.#exists = false;
    } else {
      const model = this.#model;
      const now = freshTimestamp();
      const keys = [model.DELETED_AT];
      if (model.timestamps && model.UPDATED_AT) keys.push(model.UPDATED_AT);
      for (const key of keys) this.#assign(key, now);
      await this.#byKey(connection).update(this.#columnValues(keys));
      for (const key of keys) this.#original[key] = snapshot(now);
    }
    await fire(this, "deleted", connection);
    return true;
  }

  /** Brings back a soft-deleted model, firing restoring (which can cancel), the save events and restored. */
  async restore(): Promise<boolean> {
    const model = this.#model;
    if (!model.softDeletes) throw new Error(`Tenora: ${model.name} does not use soft deletes, so there is nothing to restore.`);
    return this.#run(async (connection) => {
      if (!(await fire(this, "restoring", connection))) return false;
      this.#assign(model.DELETED_AT, null);
      this.#exists = true;
      const saved = await this.save();
      if (saved) await fire(this, "restored", connection);
      return saved;
    });
  }

  /** Whether the model is soft-deleted. */
  trashed(): boolean {
    const model = this.#model;
    const value = (this as any)[model.DELETED_AT];
    return model.softDeletes && value !== null && value !== undefined;
  }

  /** A query for this model's row, ignoring global scopes, on the database (and pinned transaction) it uses. */
  #keyed(): ModelQuery<this> {
    const model = this.#model as unknown as ModelClass<this>;
    const transaction = this.#transaction;
    const connection = transaction?.connection ?? this.#connection ?? resolveConnection(model);
    return ModelQuery.create(model, connection, transaction).withoutGlobalScopes().whereKey(this.#originalKey());
  }

  /** Reads the row again and replaces the attributes with it. */
  async refresh(): Promise<this> {
    if (!this.#exists) return this;
    const fresh = await this.#keyed().first();
    if (!fresh) throw new ModelNotFoundError(this.#model.name, [this.#originalKey()]);
    for (const key of Object.keys(this)) delete (this as any)[key];
    Object.assign(this, fresh.getAttributes());
    this.#syncOriginal();
    return this;
  }

  /** The row read again as a new instance, or undefined when it is gone. */
  async fresh(): Promise<this | undefined> {
    if (!this.#exists) return undefined;
    return this.#keyed().first();
  }

  /**
   * Pins a transaction from `beginTransaction()` on this instance: its saves and deletes, and the events they fire,
   * run in it. Without one, an instance writes to the database it came from, in whatever transaction is open there.
   */
  using(transaction: Transaction | undefined): this {
    this.#transaction = transaction;
    return this;
  }

  // Relations: eager loading arrives with relations. Property access cannot await, so a relation that was not
  // loaded cannot be loaded on read.

  relationLoaded(name: string): boolean {
    return this.#relations.has(name);
  }

  /** A loaded relation. One that was not loaded throws in strict mode, and is undefined otherwise. */
  getRelation<T = unknown>(name: string): T {
    if (this.#relations.has(name)) return this.#relations.get(name) as T;
    if (this.#model.strict) {
      throw new RelationNotLoadedError(
        `Tenora: ${this.#model.name}.${name} is not loaded. Load it with the query; reading a property cannot run one.`
      );
    }
    return undefined as T;
  }

  setRelation(name: string, value: unknown): this {
    this.#relations.set(name, value);
    return this;
  }

  unsetRelation(name: string): this {
    this.#relations.delete(name);
    return this;
  }

  getRelations(): Record<string, unknown> {
    return Object.fromEntries(this.#relations);
  }

  // Serializing

  /** The attributes, appends and loaded relations, without `hidden` ones and limited to `visible` when it is set. */
  toJSON(): Record<string, unknown> {
    const { hidden, visible, appends } = this.#model;
    const shown = (key: string) => (visible.length === 0 || visible.includes(key)) && !hidden.includes(key);
    const json: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this)) if (shown(key)) json[key] = value;
    for (const key of appends) if (shown(key)) json[key] = (this as any)[key];
    for (const [key, value] of this.#relations) if (shown(key)) json[key] = toArray(value);
    return json;
  }

  // Static: queries

  /** A query of this model on its connection. */
  static query<M extends Model>(this: ModelClass<M>): ModelQuery<M> {
    return ModelQuery.create(this, resolveConnection(this));
  }

  /** A query of this model on an explicit connection. */
  static on<M extends Model>(this: ModelClass<M>, connection: Connection): ModelQuery<M> {
    return ModelQuery.create(this, connection);
  }

  /** A query of this model in a transaction from `beginTransaction()`. Models it loads do not stay pinned to it. */
  static using<M extends Model>(this: ModelClass<M>, transaction: Transaction): ModelQuery<M> {
    return ModelQuery.create(this, transaction.connection, transaction);
  }

  /** The model's table. */
  static getTable(): string {
    return metaOf(this).table;
  }

  static all<M extends Model>(this: ModelClass<M>): Promise<M[]> {
    return queryOf(this).get();
  }

  static where<M extends Model, K extends ColumnOf<M>>(this: ModelClass<M>, column: K, value: WhereValue<M, K>): ModelQuery<M>;
  static where<M extends Model, K extends ColumnOf<M>>(
    this: ModelClass<M>,
    column: K,
    operator: Op,
    value: WhereValue<M, K>
  ): ModelQuery<M>;
  static where<M extends Model>(this: ModelClass<M>, callback: (query: ModelQuery<M>) => ModelQuery<M>): ModelQuery<M>;
  static where<M extends Model>(this: ModelClass<M>, attributes: Attributes<M>): ModelQuery<M>;
  static where<M extends Model>(this: ModelClass<M>, ...args: unknown[]): ModelQuery<M> {
    const query = queryOf(this);
    return (query.where as (...args: unknown[]) => ModelQuery<M>).apply(query, args);
  }

  static whereIn<M extends Model, K extends ColumnOf<M>>(
    this: ModelClass<M>,
    column: K,
    values: readonly WhereValue<M, K>[] | QueryBuilder<any> | ModelQuery<any>
  ): ModelQuery<M> {
    return queryOf(this).whereIn(column, values);
  }

  static whereNotIn<M extends Model, K extends ColumnOf<M>>(
    this: ModelClass<M>,
    column: K,
    values: readonly WhereValue<M, K>[] | QueryBuilder<any> | ModelQuery<any>
  ): ModelQuery<M> {
    return queryOf(this).whereNotIn(column, values);
  }

  static whereNull<M extends Model>(this: ModelClass<M>, column: ColumnOf<M>): ModelQuery<M> {
    return queryOf(this).whereNull(column);
  }

  static whereNotNull<M extends Model>(this: ModelClass<M>, column: ColumnOf<M>): ModelQuery<M> {
    return queryOf(this).whereNotNull(column);
  }

  static whereKey<M extends Model>(this: ModelClass<M>, id: unknown): ModelQuery<M> {
    return queryOf(this).whereKey(id);
  }

  static orderBy<M extends Model>(this: ModelClass<M>, column: ColumnOf<M>, direction?: "asc" | "desc"): ModelQuery<M> {
    return queryOf(this).orderBy(column, direction);
  }

  static latest<M extends Model>(this: ModelClass<M>, column?: ColumnOf<M>): ModelQuery<M> {
    return queryOf(this).latest(column);
  }

  static oldest<M extends Model>(this: ModelClass<M>, column?: ColumnOf<M>): ModelQuery<M> {
    return queryOf(this).oldest(column);
  }

  static select<M extends Model>(this: ModelClass<M>, ...columns: (ColumnOf<M> | "*")[]): ModelQuery<M> {
    return queryOf(this).select(...columns);
  }

  static limit<M extends Model>(this: ModelClass<M>, count: number): ModelQuery<M> {
    return queryOf(this).limit(count);
  }

  static withTrashed<M extends Model>(this: ModelClass<M>): ModelQuery<M> {
    return queryOf(this).withTrashed();
  }

  static onlyTrashed<M extends Model>(this: ModelClass<M>): ModelQuery<M> {
    return queryOf(this).onlyTrashed();
  }

  static withoutGlobalScope<M extends Model>(this: ModelClass<M>, ...names: string[]): ModelQuery<M> {
    return queryOf(this).withoutGlobalScope(...names);
  }

  static withoutGlobalScopes<M extends Model>(this: ModelClass<M>, names?: readonly string[]): ModelQuery<M> {
    return queryOf(this).withoutGlobalScopes(names);
  }

  static find<M extends Model>(this: ModelClass<M>, id: unknown): Promise<M | undefined>;
  static find<M extends Model>(this: ModelClass<M>, ids: readonly unknown[]): Promise<M[]>;
  static find<M extends Model>(this: ModelClass<M>, id: unknown): Promise<M | undefined | M[]> {
    return queryOf(this).find(id as any);
  }

  static findOrFail<M extends Model>(this: ModelClass<M>, id: unknown): Promise<M>;
  static findOrFail<M extends Model>(this: ModelClass<M>, ids: readonly unknown[]): Promise<M[]>;
  static findOrFail<M extends Model>(this: ModelClass<M>, id: unknown): Promise<M | M[]> {
    return queryOf(this).findOrFail(id as any);
  }

  static findMany<M extends Model>(this: ModelClass<M>, ids: readonly unknown[]): Promise<M[]> {
    return queryOf(this).findMany(ids);
  }

  static first<M extends Model>(this: ModelClass<M>): Promise<M | undefined> {
    return queryOf(this).first();
  }

  static firstOrFail<M extends Model>(this: ModelClass<M>): Promise<M> {
    return queryOf(this).firstOrFail();
  }

  static count<M extends Model>(this: ModelClass<M>, column?: ColumnOf<M> | "*"): Promise<number> {
    return queryOf(this).count(column);
  }

  static exists<M extends Model>(this: ModelClass<M>): Promise<boolean> {
    return queryOf(this).exists();
  }

  static pluck<M extends Model, K extends ColumnOf<M>>(this: ModelClass<M>, column: K): Promise<ValueOf<M, K>[]> {
    return queryOf(this).pluck(column);
  }

  static paginate<M extends Model>(this: ModelClass<M>, options?: { page?: number; perPage?: number }): Promise<Page<M>> {
    return queryOf(this).paginate(options);
  }

  static chunkById<M extends Model>(
    this: ModelClass<M>,
    count: number,
    callback: (models: M[], page: number) => unknown
  ): Promise<boolean> {
    return queryOf(this).chunkById(count, callback);
  }

  static lazyById<M extends Model>(this: ModelClass<M>, count?: number): AsyncGenerator<M, void, undefined> {
    return queryOf(this).lazyById(count);
  }

  // Static: writes

  /** A new, unsaved model filled with `attributes`. */
  static make<M extends Model>(this: ModelClass<M>, attributes: Attributes<M> = {}): M {
    return new this().fill(attributes as Attributes<M>);
  }

  /** Fills a new model and saves it. */
  static create<M extends Model>(this: ModelClass<M>, attributes: Attributes<M> = {}): Promise<M> {
    return queryOf(this).create(attributes);
  }

  /** The first model matching `attributes`, or a new unsaved one filled with them and `values`. */
  static firstOrNew<M extends Model>(this: ModelClass<M>, attributes: Attributes<M>, values?: Attributes<M>): Promise<M> {
    return queryOf(this).firstOrNew(attributes, values);
  }

  /** The first model matching `attributes`, or one created with them and `values`. */
  static firstOrCreate<M extends Model>(this: ModelClass<M>, attributes: Attributes<M>, values?: Attributes<M>): Promise<M> {
    return queryOf(this).firstOrCreate(attributes, values);
  }

  /** Creates the model, or, when a unique key already has it, returns the existing one. */
  static createOrFirst<M extends Model>(this: ModelClass<M>, attributes: Attributes<M>, values?: Attributes<M>): Promise<M> {
    return queryOf(this).createOrFirst(attributes, values);
  }

  /** Updates the first model matching `attributes` with `values`, or creates it with both. */
  static updateOrCreate<M extends Model>(this: ModelClass<M>, attributes: Attributes<M>, values?: Attributes<M>): Promise<M> {
    return queryOf(this).updateOrCreate(attributes, values);
  }

  /** Inserts rows, or updates the ones whose unique key exists, without model events. */
  static upsert<M extends Model>(
    this: ModelClass<M>,
    values: Attributes<M> | readonly Attributes<M>[],
    uniqueBy: AttributeName<M> | readonly AttributeName<M>[],
    update?: readonly AttributeName<M>[]
  ): Promise<number> {
    return queryOf(this).upsert(values, uniqueBy, update);
  }

  /** Loads the models with these keys and deletes each, firing their events. Returns how many were deleted. */
  static async destroy<M extends Model>(this: ModelClass<M>, ids: unknown): Promise<number> {
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length) return 0;
    let deleted = 0;
    for (const model of await queryOf(this).findMany(list)) if (await model.delete()) deleted++;
    return deleted;
  }

  // Static: events and scopes

  /** Registers a global scope by name; `withoutGlobalScope(name)` leaves it out. */
  static addGlobalScope<M extends Model>(this: ModelClass<M>, name: string, scope: (query: ModelQuery<M>) => ModelQuery<M>): void {
    addGlobalScope(this, name, scope);
  }

  /** Registers an object or class with a method per event: `User.observe(UserObserver)`. */
  static observe<M extends Model>(this: ModelClass<M>, observer: Observer<M> | ObserverClass<M>): void {
    observe(this, observer);
  }

  /** Removes the listeners and observers registered on this class (not those of the classes it extends). */
  static flushEventListeners(): void {
    forget(this);
  }

  static retrieved<M extends Model>(this: ModelClass<M>, listener: EventListener<M>, options?: ListenerOptions): void {
    listen(this, "retrieved", listener, options);
  }

  /** Before an insert; returning false cancels it. */
  static creating<M extends Model>(this: ModelClass<M>, listener: EventListener<M>): void {
    listen(this, "creating", listener);
  }

  static created<M extends Model>(this: ModelClass<M>, listener: EventListener<M>, options?: ListenerOptions): void {
    listen(this, "created", listener, options);
  }

  /** Before an update of a model with changes; returning false cancels it. */
  static updating<M extends Model>(this: ModelClass<M>, listener: EventListener<M>): void {
    listen(this, "updating", listener);
  }

  static updated<M extends Model>(this: ModelClass<M>, listener: EventListener<M>, options?: ListenerOptions): void {
    listen(this, "updated", listener, options);
  }

  /** Before every save, insert or update; returning false cancels it. */
  static saving<M extends Model>(this: ModelClass<M>, listener: EventListener<M>): void {
    listen(this, "saving", listener);
  }

  static saved<M extends Model>(this: ModelClass<M>, listener: EventListener<M>, options?: ListenerOptions): void {
    listen(this, "saved", listener, options);
  }

  /** Before a delete or soft delete; returning false cancels it. */
  static deleting<M extends Model>(this: ModelClass<M>, listener: EventListener<M>): void {
    listen(this, "deleting", listener);
  }

  static deleted<M extends Model>(this: ModelClass<M>, listener: EventListener<M>, options?: ListenerOptions): void {
    listen(this, "deleted", listener, options);
  }

  /** Before a soft-deleted model is restored; returning false cancels it. */
  static restoring<M extends Model>(this: ModelClass<M>, listener: EventListener<M>): void {
    listen(this, "restoring", listener);
  }

  static restored<M extends Model>(this: ModelClass<M>, listener: EventListener<M>, options?: ListenerOptions): void {
    listen(this, "restored", listener, options);
  }

  /** Before a forceDelete(); returning false cancels it. */
  static forceDeleting<M extends Model>(this: ModelClass<M>, listener: EventListener<M>): void {
    listen(this, "forceDeleting", listener);
  }

  static forceDeleted<M extends Model>(this: ModelClass<M>, listener: EventListener<M>, options?: ListenerOptions): void {
    listen(this, "forceDeleted", listener, options);
  }
}
