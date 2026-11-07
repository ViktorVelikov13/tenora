import type { ColumnInfo, ForeignKeyInfo, IndexInfo, ReferentialAction } from "./types";

/** Splits "timestamp(3) with time zone" into "timestamp with time zone" and ["3"]. */
export const splitType = (raw: string): { base: string; args: string[] } => {
  const match = /\(([^()]*)\)/.exec(raw);
  const base = match ? raw.slice(0, match.index) + raw.slice(match.index + match[0].length) : raw;
  return {
    base: base.replace(/\s+/g, " ").trim().toLowerCase(),
    args: match ? match[1].split(",").map((arg) => arg.trim()).filter(Boolean) : [],
  };
};

const LENGTH_TYPES = new Set([
  "char",
  "varchar",
  "nchar",
  "nvarchar",
  "binary",
  "varbinary",
  "bit",
  "varbit",
  "character",
  "character varying",
  "native character",
  "varying character",
  "nvarchar2",
]);
const DECIMAL_TYPES = new Set(["decimal", "numeric"]);
const FLOAT_TYPES = new Set(["float", "double", "double precision", "real"]);
const TIME_TYPES = new Set([
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
  "datetime",
  "datetime2",
  "datetimeoffset",
]);

const toNumber = (arg: string | undefined) => (arg !== undefined && /^\d+$/.test(arg) ? Number(arg) : null);

/** Length, precision and scale from a type's arguments, for the types where they mean something. */
export const typeSizes = (type: string, args: string[]): Pick<ColumnInfo, "length" | "precision" | "scale"> => {
  if (LENGTH_TYPES.has(type)) return { length: toNumber(args[0]), precision: null, scale: null };
  if (DECIMAL_TYPES.has(type)) {
    const precision = toNumber(args[0]);
    return { length: null, precision, scale: precision === null ? null : (toNumber(args[1]) ?? 0) };
  }
  if (FLOAT_TYPES.has(type)) return { length: null, precision: toNumber(args[0]), scale: toNumber(args[1]) };
  if (TIME_TYPES.has(type)) return { length: null, precision: toNumber(args[0]), scale: null };
  return { length: null, precision: null, scale: null };
};

/** "SET_NULL", "SET NULL" or "set null" → "set null". */
export const referentialAction = (value: unknown): ReferentialAction => {
  const action = String(value ?? "no action")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
  switch (action) {
    case "no action":
    case "restrict":
    case "cascade":
    case "set null":
    case "set default":
      return action;
    default:
      throw new Error(`Tenora: unknown referential action "${String(value)}".`);
  }
};

/** Drivers return booleans as true/false, 1/0, "YES"/"NO" or "1"/"0", depending on the database. */
export const truthy = (value: unknown) =>
  value === true || value === 1 || value === "1" || value === 1n || value === "YES" || value === "yes";

/** Code-point order, so the result does not depend on the database's collation or the machine's locale. */
export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const byNameThenColumns = (
  a: { name: string | null; columns: string[] },
  b: { name: string | null; columns: string[] }
) => compareText(a.name ?? "", b.name ?? "") || compareText(a.columns.join(), b.columns.join());

export const sortIndexes = (indexes: IndexInfo[]) => indexes.sort(byNameThenColumns);

export const sortForeignKeys = (foreignKeys: ForeignKeyInfo[]) => foreignKeys.sort(byNameThenColumns);

/** Groups catalog rows that list one key column each into one entry per index or constraint, in key order. */
export const groupBy = <Row, Key>(rows: Row[], key: (row: Row) => Key): Map<Key, Row[]> => {
  const groups = new Map<Key, Row[]>();
  for (const row of rows) {
    const k = key(row);
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return groups;
};

/** Patterns from `exclude` as one test: `*` matches any run of characters, and names compare case-insensitively. */
export const excluder = (patterns: ReadonlyArray<string | RegExp> = []) => {
  const tests = patterns.map((pattern) =>
    typeof pattern === "string"
      ? new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i")
      : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""))
  );
  return (name: string) => tests.some((test) => test.test(name));
};
