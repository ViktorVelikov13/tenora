import type { QueryBuilder } from "../query/builder";
import type { RawSql } from "../sql";
import type { CastFor } from "./casts";
import type { Model } from "./model";
import type { ModelQuery } from "./query";

type AnyFunction = (...args: any[]) => any;

/**
 * A model's attributes, from its `declare`d fields: every property that is not a method and not part of Model itself.
 * One mapped type per model, which TypeScript computes once and caches, so it stays cheap on large model sets.
 */
export type Fields<M> = {
  [K in keyof M as K extends keyof Model ? never : M[K] extends AnyFunction ? never : K]: M[K];
};

/** The attribute names of a model: "id", "createdAt", … */
export type AttributeName<M> = keyof Fields<M> & string;

/** Attributes to fill or create a model with. */
export type Attributes<M> = Partial<Fields<M>>;

/**
 * A column a model query accepts: one of the model's attributes, which is checked, or a qualified "table.column" for
 * joins, which is not.
 */
export type ColumnOf<M> = AttributeName<M> | `${string}.${string}`;

/** The value type of an attribute, or unknown for a qualified column. */
export type ValueOf<M, K> = K extends keyof Fields<M> ? Fields<M>[K] : unknown;

/** A date attribute also compares with a string or a timestamp. */
type Comparable<V> = V extends Date ? V | string | number : V;

/** What a condition on a column compares with: a value of the attribute's type, null, a raw fragment or a subquery. */
export type WhereValue<M, K> = Comparable<ValueOf<M, K>> | null | RawSql | QueryBuilder<any> | ModelQuery<any>;

/** Values for a mass update: attributes, or raw fragments such as `sql\`votes + 1\``. */
export type UpdateValues<M> = { [K in keyof Fields<M>]?: Fields<M>[K] | null | RawSql };

/**
 * A model class whose instances are M. Static methods take `this: ModelClass<M>`, so `User.query()` is a query of
 * User without repeating the type.
 */
export type ModelClass<M extends Model = Model> = (new (attributes?: Record<string, unknown>) => M) & typeof Model;

/**
 * The casts a model may declare, checked against its declared fields:
 * `static casts = { isAdmin: "boolean", settings: cast.json<Settings>() } satisfies Casts<User>;`
 */
export type Casts<M> = { [K in keyof Fields<M>]?: CastFor<Fields<M>[K]> };

/** One page of results from `paginate()`. */
export type Page<M> = {
  data: M[];
  /** rows matching the query, on every page */
  total: number;
  page: number;
  perPage: number;
  /** the last page number; 1 when there are no rows */
  lastPage: number;
};

export type Truthy<T> = Exclude<T, false | null | undefined | 0 | "">;
