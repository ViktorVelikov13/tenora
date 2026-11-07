/**
 * Casts turn what the database returns into the value an attribute holds, and back. They run when a model is read
 * and written; in between, an attribute holds whatever was assigned to it. Null is stored and read as null without
 * calling the cast.
 */
export type Cast<T = unknown> = {
  /** the attribute's value from what the database returned */
  get(value: unknown): T;
  /** the value written to the database from the attribute's value */
  set(value: T): unknown;
};

type BuiltinCasts = {
  boolean: boolean;
  integer: number;
  float: number;
  string: string;
  json: any;
  /** a Date; SQLite stores it as milliseconds since the epoch, as 0.x did */
  datetime: Date;
  /** a "YYYY-MM-DD" string, since a JavaScript Date always has a time and a timezone */
  date: string;
};

export type CastName = keyof BuiltinCasts;
export type CastDefinition = CastName | Cast<any>;

/** The value type a cast gives an attribute: `CastValue<"boolean">` is boolean, `CastValue<Cast<Money>>` is Money. */
export type CastValue<C> = C extends CastName ? BuiltinCasts[C] : C extends { get(value: unknown): infer T } ? T : never;

/** The casts that fit a value type: "boolean" for boolean, "integer" or "float" for number, a `Cast<T>` for T. */
export type CastFor<T> =
  | { [N in CastName]: BuiltinCasts[N] extends NonNullable<T> ? N : never }[CastName]
  | Cast<NonNullable<T>>;

/** @internal A cast ready to use: null passes through, and json values are compared by content. */
export type AttributeCast = {
  get(value: unknown): unknown;
  set(value: unknown): unknown;
  readonly json: boolean;
};

const invalid = (value: unknown, kind: string) =>
  new Error(`Tenora: ${JSON.stringify(String(value))} is not a valid ${kind}.`);

const toBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "bigint") return value != 0;
  // MySQL returns a BIT(1) column as a buffer.
  if (value instanceof Uint8Array) return value.some((byte) => byte !== 0);
  if (typeof value === "string") return !["", "0", "false", "f", "off", "no"].includes(value.trim().toLowerCase());
  return Boolean(value);
};

const toNumber = (value: unknown, kind: string): number => {
  const number = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(number) || (typeof value === "string" && !value.trim())) throw invalid(value, kind);
  return number;
};

// SQL's own format without a zone, as SQLite writes CURRENT_TIMESTAMP: read as UTC, not as local time.
const SQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

const toDate = (value: unknown): Date => {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === "number") date = new Date(value);
  else if (typeof value === "bigint") date = new Date(Number(value));
  else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) date = new Date(Number(value));
  else if (typeof value === "string" && SQL_DATETIME.test(value.trim())) date = new Date(`${value.trim().replace(" ", "T")}Z`);
  else if (typeof value === "string") date = new Date(value);
  else throw invalid(value, "date");
  if (Number.isNaN(date.getTime())) throw invalid(value, "date");
  return date;
};

const pad = (number: number, length = 2) => String(number).padStart(length, "0");

/**
 * The calendar day of a date column as "YYYY-MM-DD". pg, mysql2 and mariadb return a DATE as local midnight and
 * tedious as UTC midnight, and new Date("2026-11-07") is UTC midnight too, so a Date exactly at UTC midnight is read in
 * UTC and any other Date in local time.
 */
const toDay = (value: unknown): string => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value.trim())) return value.trim().slice(0, 10);
  const date = toDate(value);
  const utcMidnight =
    date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  const localMidnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
  return utcMidnight && !localMidnight
    ? `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    : `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const parseJson = (value: unknown): unknown => {
  // pg and mysql2 parse JSON columns themselves; SQLite, SQL Server and MariaDB return text.
  const text = value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value;
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const BUILTIN: Record<CastName, Cast<any>> = {
  boolean: { get: toBoolean, set: toBoolean },
  integer: {
    get: (value) => Math.trunc(toNumber(value, "integer")),
    set: (value) => Math.trunc(toNumber(value, "integer")),
  },
  float: { get: (value) => toNumber(value, "number"), set: (value) => toNumber(value, "number") },
  string: { get: (value) => String(value), set: (value) => String(value) },
  json: { get: parseJson, set: (value) => JSON.stringify(value) },
  datetime: { get: toDate, set: toDate },
  date: { get: toDay, set: toDay },
};

/** A JSON cast typed as T: `settings: cast.json<UserSettings>()`. */
const json = <T = unknown>(): Cast<T> => BUILTIN.json as Cast<T>;

export const cast = { json };

/** @internal */
export const resolveCast = (definition: unknown, where: string): AttributeCast => {
  const cast =
    typeof definition === "string"
      ? BUILTIN[definition as CastName]
      : definition && typeof (definition as Cast).get === "function" && typeof (definition as Cast).set === "function"
        ? (definition as Cast)
        : undefined;
  if (!cast) {
    throw new Error(
      `Tenora: unknown cast ${JSON.stringify(definition)} for ${where}; use ${Object.keys(BUILTIN).join(", ")}, cast.json<T>() or { get, set }.`
    );
  }
  return {
    get: (value) => (value === null || value === undefined ? value : cast.get(value)),
    set: (value) => (value === null || value === undefined ? value : cast.set(value)),
    json: cast === BUILTIN.json,
  };
};

/** @internal The datetime cast that timestamps and deletedAt get when no other cast is declared for them. */
export const DATETIME_CAST = resolveCast("datetime", "timestamps");

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** JSON with object keys sorted, so two values with the same content compare equal whatever their key order. */
const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    isPlainObject(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item
  ) ?? "undefined";

/**
 * @internal What decides whether an attribute changed: the value its cast would write, so `1` and `true` under a
 * boolean cast are the same, and a number equals its digits (Postgres returns BIGINT as a string). JSON compares by
 * content: Postgres's jsonb reorders keys.
 */
export const fingerprint = (cast: AttributeCast | undefined, value: unknown): string => {
  if (value === null || value === undefined) return "\u0000null";
  if (cast?.json) return stableStringify(value);
  const raw = cast ? cast.set(value) : value;
  if (raw === null || raw === undefined) return "\u0000null";
  if (raw instanceof Date) return `\u0000date:${raw.getTime()}`;
  if (raw instanceof Uint8Array) return `\u0000bytes:${Buffer.from(raw).toString("hex")}`;
  if (typeof raw === "object") return stableStringify(raw);
  return String(raw);
};

/** @internal A copy of a value for getOriginal(), so changing a date or a JSON object in place shows as a change. */
export const snapshot = (value: unknown): unknown => {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value) || isPlainObject(value)) {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }
  return value;
};
