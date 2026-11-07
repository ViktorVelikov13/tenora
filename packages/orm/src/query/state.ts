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

export type Where =
  | { type: "basic"; column: string; operator: Operator; value: unknown; boolean: Conjunction }
  | { type: "in"; column: string; values: readonly unknown[]; not: boolean; boolean: Conjunction }
  | { type: "null"; column: string; not: boolean; boolean: Conjunction }
  | { type: "nested"; wheres: readonly Where[]; boolean: Conjunction }
  | { type: "raw"; sql: RawSql; boolean: Conjunction };

export type Order = { column: string | RawSql; direction: "asc" | "desc" };

export type Aggregate = { fn: "count" | "sum" | "avg" | "min" | "max"; column: string };

export type SelectState = {
  kind: "select";
  table: string;
  columns: readonly string[];
  distinct: boolean;
  wheres: readonly Where[];
  orders: readonly Order[];
  limit: number | undefined;
  offset: number | undefined;
  lock: "update" | undefined;
  skipLocked: boolean;
  aggregate: Aggregate | undefined;
};

export type InsertState = {
  kind: "insert";
  table: string;
  rows: readonly Record<string, unknown>[];
  returning: readonly string[] | undefined;
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

export type QueryState = SelectState | InsertState | UpdateState | DeleteState;
