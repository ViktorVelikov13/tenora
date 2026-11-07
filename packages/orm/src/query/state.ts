import type { RawSql } from "../sql";

/** Comparison operators accepted by `where`. Anything else is rejected, so an operator can never carry SQL. */
export const OPERATORS = [
  "=",
  "!=",
  "<>",
  "<",
  "<=",
  ">",
  ">=",
  "like",
  "not like",
  "ilike",
  "not ilike",
] as const;

export type Operator = (typeof OPERATORS)[number];

export type Conjunction = "and" | "or";

/** A select used inside another query: in `whereIn`, `whereExists`, a comparison, a join, `fromSub` or `selectSub`. */
export class SubQuery {
  constructor(readonly state: SelectState) {}
}

/** Where rows come from: a table (`"users"` or `"users as u"`), or a subquery with an alias. */
export type Source = { type: "table"; name: string } | { type: "sub"; query: SelectState; alias: string };

export type Where =
  /** a column compared with a value, which is bound as a parameter (or a raw fragment, or a subquery) */
  | { type: "basic"; column: string; operator: Operator; value: unknown; boolean: Conjunction }
  /** two columns compared with each other, as in a join condition */
  | { type: "column"; first: string; operator: Operator; second: string; boolean: Conjunction }
  | { type: "in"; column: string; values: readonly unknown[] | SubQuery; not: boolean; boolean: Conjunction }
  | { type: "null"; column: string; not: boolean; boolean: Conjunction }
  | { type: "between"; column: string; low: unknown; high: unknown; not: boolean; boolean: Conjunction }
  | { type: "exists"; query: SelectState; not: boolean; boolean: Conjunction }
  | { type: "nested"; wheres: readonly Where[]; boolean: Conjunction }
  | { type: "raw"; sql: RawSql; boolean: Conjunction };

export type Join = {
  type: "inner" | "left" | "right" | "cross";
  source: Source;
  conditions: readonly Where[];
};

export type Selection =
  | { type: "column"; name: string }
  | { type: "raw"; sql: RawSql }
  | { type: "sub"; query: SelectState; alias: string };

export type Order =
  | { type: "column"; column: string; direction: "asc" | "desc" }
  | { type: "raw"; sql: RawSql }
  | { type: "random" };

export type Aggregate = { fn: "count" | "sum" | "avg" | "min" | "max"; column: string };

export type SelectState = {
  kind: "select";
  from: Source;
  columns: readonly Selection[];
  distinct: boolean;
  joins: readonly Join[];
  wheres: readonly Where[];
  groups: readonly string[];
  havings: readonly Where[];
  orders: readonly Order[];
  limit: number | undefined;
  offset: number | undefined;
  unions: readonly { query: SelectState; all: boolean }[];
  lock: "update" | "share" | undefined;
  skipLocked: boolean;
  aggregate: Aggregate | undefined;
};

export type InsertState = {
  kind: "insert";
  table: string;
  rows: readonly Record<string, unknown>[];
  returning: readonly string[] | undefined;
};

export type UpsertState = {
  kind: "upsert";
  table: string;
  rows: readonly Record<string, unknown>[];
  /** the columns of the unique key that decides whether a row already exists */
  uniqueBy: readonly string[];
  /** the columns to overwrite when it does; none means the existing row is left as it is */
  update: readonly string[];
};

export type UpdateState = {
  kind: "update";
  table: string;
  values: Readonly<Record<string, unknown>>;
  wheres: readonly Where[];
};

export type DeleteState = {
  kind: "delete";
  table: string;
  wheres: readonly Where[];
};

export type QueryState = SelectState | InsertState | UpsertState | UpdateState | DeleteState;

export const emptySelect = (from: Source): SelectState => ({
  kind: "select",
  from,
  columns: [],
  distinct: false,
  joins: [],
  wheres: [],
  groups: [],
  havings: [],
  orders: [],
  limit: undefined,
  offset: undefined,
  unions: [],
  lock: undefined,
  skipLocked: false,
  aggregate: undefined,
});
