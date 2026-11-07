/**
 * The table callback of the Knex-compatible schema builder: Knex's method names, recorded the way Knex records them,
 * so that `compiler.ts` can produce the SQL Knex 3.3 produces. Used by migrations converted from 0.x.
 *
 * Unlike Tenora's query builder this one changes in place: a Knex callback calls `t.string("x").nullable()` and drops
 * what it returns, so the column has to be the one recorded.
 */
import type { Dialect } from "../../dialect";
import { sql } from "../../sql";

export type KnexForeignData = {
  column: string | string[];
  keyName?: string;
  references?: string | string[];
  inTable?: string;
  onDelete?: string;
  onUpdate?: string;
  deferrable?: string;
};

export type KnexColumnStatement = { readonly grouping: "columns"; readonly builder: KnexColumnBuilder };
export type KnexAlterStatement = { readonly grouping: "alterTable"; readonly method: string; readonly args: unknown[] };
export type KnexTableStatement = KnexColumnStatement | KnexAlterStatement;

type Columns = string | readonly string[];
type ModifierName = "defaultTo" | "nullable" | "unsigned";

// Knex's aliases: the compiler sees these names.
const COLUMN_ALIAS: Record<string, string> = {
  float: "floating",
  enum: "enu",
  boolean: "bool",
  string: "varchar",
  bigint: "bigInteger",
};

const NO_DEFERRABLE: readonly Dialect[] = ["mysql", "mariadb", "mssql"];

/** Knex's `knex.raw("CURRENT_TIMESTAMP")`, which `timestamps(…, true)` uses as the default. */
const CURRENT_TIMESTAMP = sql`CURRENT_TIMESTAMP`;

const setReferences = (foreign: KnexForeignData, tableColumn: string | readonly string[]) => {
  const pieces = typeof tableColumn === "string" ? tableColumn.split(".") : undefined;
  if (!pieces || pieces.length === 1) {
    foreign.references = pieces ? pieces[0] : [...tableColumn];
  } else {
    // "teams.id"; as in Knex, a third part is ignored.
    foreign.inTable = pieces[0];
    foreign.references = pieces[1];
  }
};

const setTable = (foreign: KnexForeignData, table: unknown) => {
  if (typeof table !== "string") throw new TypeError(`Tenora: inTable() expects a table name, got ${typeof table}.`);
  foreign.inTable = table;
};

/** `t.foreign("team_id").references("teams.id").onDelete("CASCADE")` */
export class KnexForeignBuilder {
  /** @internal */
  constructor(
    private readonly data: KnexForeignData,
    private readonly dialect: Dialect
  ) {}

  references(tableColumn: string | readonly string[]): this {
    setReferences(this.data, tableColumn);
    return this;
  }

  inTable(table: string): this {
    setTable(this.data, table);
    return this;
  }

  on(table: string): this {
    return this.inTable(table);
  }

  withKeyName(keyName: string): this {
    this.data.keyName = keyName;
    return this;
  }

  onDelete(action: string): this {
    this.data.onDelete = action;
    return this;
  }

  onUpdate(action: string): this {
    this.data.onUpdate = action;
    return this;
  }

  deferrable(type: "deferred" | "immediate" | "not deferrable"): this {
    if (NO_DEFERRABLE.includes(this.dialect)) {
      throw new Error(`Tenora: ${this.dialect} does not support deferrable foreign keys.`);
    }
    this.data.deferrable = type;
    return this;
  }
}

export class KnexColumnBuilder {
  /** @internal */ method: "add" | "alter" = "add";
  /** @internal */ readonly modifiers: { [name in ModifierName]?: unknown[] } = {};
  /** @internal */ alterNullable = true;
  /** @internal */ alterType = true;
  #foreign: KnexForeignBuilder | undefined;

  /** @internal */
  constructor(
    /** @internal */ readonly table: KnexTableBuilder,
    /** @internal */ readonly type: string,
    /** @internal */ readonly args: readonly unknown[]
  ) {}

  #modifier(name: ModifierName, args: unknown[]): this {
    this.modifiers[name] = args;
    return this;
  }

  /** Increments columns ignore index(), primary() and unique(), as in Knex. */
  #index(method: "index" | "primary" | "unique", args: unknown[]): this {
    if (!this.type.toLowerCase().includes("increments")) {
      (this.table as any)[method](this.args[0], ...args);
    }
    return this;
  }

  nullable(): this {
    return this.#modifier("nullable", []);
  }

  notNullable(): this {
    return this.#modifier("nullable", [false]);
  }

  notNull(): this {
    return this.notNullable();
  }

  /** A value, or a `sql` fragment such as sql`CURRENT_TIMESTAMP`, which is written as is. */
  defaultTo(value: unknown, options?: { constraintName?: string }): this {
    return this.#modifier("defaultTo", options === undefined ? [value] : [value, options]);
  }

  default(value: unknown, options?: { constraintName?: string }): this {
    return this.defaultTo(value, options);
  }

  defaultsTo(value: unknown, options?: { constraintName?: string }): this {
    return this.defaultTo(value, options);
  }

  /** MySQL only; other databases ignore it, as Knex does. */
  unsigned(): this {
    return this.#modifier("unsigned", []);
  }

  primary(constraintName?: string | { constraintName?: string; deferrable?: string }): this {
    return this.#index("primary", constraintName === undefined ? [] : [constraintName]);
  }

  unique(indexName?: string | { indexName?: string; deferrable?: string; useConstraint?: boolean }): this {
    return this.#index("unique", indexName === undefined ? [] : [indexName]);
  }

  index(indexName?: string, options?: string | { indexType?: string; storageEngineIndexType?: string }): this {
    const args: unknown[] = [];
    if (indexName !== undefined || options !== undefined) args.push(indexName);
    if (options !== undefined) args.push(options);
    return this.#index("index", args);
  }

  /** `references("teams.id")`, or `references("id").inTable("teams")`. */
  references(tableColumn: string): this {
    this.#foreign ??= this.table.foreign(this.args[0] as string);
    this.#foreign.references(tableColumn);
    return this;
  }

  #foreignKey(method: string): KnexForeignBuilder {
    if (!this.#foreign) throw new Error(`Tenora: ${method}() needs references() first.`);
    return this.#foreign;
  }

  inTable(table: string): this {
    this.#foreignKey("inTable").inTable(table);
    return this;
  }

  on(table: string): this {
    return this.inTable(table);
  }

  onDelete(action: string): this {
    this.#foreignKey("onDelete").onDelete(action);
    return this;
  }

  onUpdate(action: string): this {
    this.#foreignKey("onUpdate").onUpdate(action);
    return this;
  }

  withKeyName(keyName: string): this {
    this.#foreignKey("withKeyName").withKeyName(keyName);
    return this;
  }

  deferrable(type: "deferred" | "immediate" | "not deferrable"): this {
    this.#foreignKey("deferrable").deferrable(type);
    return this;
  }

  /** Changes an existing column to this definition (in alterTable() only). */
  alter(options: { alterNullable?: boolean; alterType?: boolean } = {}): this {
    if (this.table.method !== "alter") throw new Error("Tenora: alter() only works inside alterTable().");
    this.method = "alter";
    this.alterNullable = options.alterNullable ?? true;
    this.alterType = options.alterType ?? true;
    return this;
  }
}

type DateTimeOptions = boolean | number | { useTz?: boolean; precision?: number };

export class KnexTableBuilder {
  /** @internal */ readonly statements: KnexTableStatement[] = [];
  /** @internal */ readonly single: { engine?: string; charset?: string; collate?: string } = {};

  /** @internal */
  constructor(
    /** @internal */ readonly dialect: Dialect,
    /** @internal */ readonly method: "create" | "createIfNot" | "alter",
    /** @internal */ readonly tableName: string
  ) {}

  #column(type: string, args: unknown[]): KnexColumnBuilder {
    const builder = new KnexColumnBuilder(this, COLUMN_ALIAS[type] ?? type, args);
    this.statements.push({ grouping: "columns", builder });
    return builder;
  }

  #statement(method: string, args: unknown[]): this {
    this.statements.push({ grouping: "alterTable", method, args });
    return this;
  }

  #alterOnly(method: string) {
    if (this.method !== "alter") throw new Error(`Tenora: ${method}() only works inside alterTable().`);
  }

  // Column types. Optional arguments are recorded only when given, since Knex's defaults depend on that.

  increments(name?: string, options?: { primaryKey?: boolean }): KnexColumnBuilder {
    return this.#column("increments", trim([name, options]));
  }

  bigIncrements(name?: string, options?: { primaryKey?: boolean }): KnexColumnBuilder {
    return this.#column("bigIncrements", trim([name, options]));
  }

  bigincrements(name?: string, options?: { primaryKey?: boolean }): KnexColumnBuilder {
    return this.#column("bigincrements", trim([name, options]));
  }

  integer(name: string, length?: number): KnexColumnBuilder {
    return this.#column("integer", trim([name, length]));
  }

  bigInteger(name: string): KnexColumnBuilder {
    return this.#column("bigInteger", [name]);
  }

  biginteger(name: string): KnexColumnBuilder {
    return this.#column("biginteger", [name]);
  }

  bigint(name: string): KnexColumnBuilder {
    return this.#column("bigint", [name]);
  }

  smallint(name: string): KnexColumnBuilder {
    return this.#column("smallint", [name]);
  }

  tinyint(name: string, length?: number): KnexColumnBuilder {
    return this.#column("tinyint", trim([name, length]));
  }

  string(name: string, length?: number): KnexColumnBuilder {
    return this.#column("string", trim([name, length]));
  }

  varchar(name: string, length?: number): KnexColumnBuilder {
    return this.#column("varchar", trim([name, length]));
  }

  /** `textType` is MySQL's "mediumtext" or "longtext". */
  text(name: string, textType?: string): KnexColumnBuilder {
    return this.#column("text", trim([name, textType]));
  }

  boolean(name: string): KnexColumnBuilder {
    return this.#column("boolean", [name]);
  }

  bool(name: string): KnexColumnBuilder {
    return this.#column("bool", [name]);
  }

  date(name: string): KnexColumnBuilder {
    return this.#column("date", [name]);
  }

  datetime(name: string, options?: DateTimeOptions): KnexColumnBuilder {
    return this.#column("datetime", trim([name, options]));
  }

  dateTime(name: string, options?: DateTimeOptions): KnexColumnBuilder {
    return this.#column("dateTime", trim([name, options]));
  }

  timestamp(name: string, options?: DateTimeOptions): KnexColumnBuilder {
    return this.#column("timestamp", trim([name, options]));
  }

  time(name: string, precision?: number | { precision?: number }): KnexColumnBuilder {
    return this.#column("time", trim([name, precision]));
  }

  decimal(name: string, precision?: number | null, scale?: number): KnexColumnBuilder {
    return this.#column("decimal", trim([name, precision, scale]));
  }

  float(name: string, precision?: number, scale?: number): KnexColumnBuilder {
    return this.#column("float", trim([name, precision, scale]));
  }

  double(name: string, precision?: number, scale?: number): KnexColumnBuilder {
    return this.#column("double", trim([name, precision, scale]));
  }

  json(name: string): KnexColumnBuilder {
    return this.#column("json", [name]);
  }

  jsonb(name: string): KnexColumnBuilder {
    return this.#column("jsonb", [name]);
  }

  uuid(name: string, options?: { useBinaryUuid?: boolean; primaryKey?: boolean }): KnexColumnBuilder {
    return this.#column("uuid", trim([name, options]));
  }

  /** Postgres can create a native enum type: `{ useNative: true, enumName: "mood" }`. */
  enu(
    name: string,
    values: readonly string[],
    options?: { useNative?: boolean; enumName?: string; existingType?: boolean; schemaName?: string }
  ): KnexColumnBuilder {
    return this.#column("enu", trim([name, values, options]));
  }

  enum(
    name: string,
    values: readonly string[],
    options?: { useNative?: boolean; enumName?: string; existingType?: boolean; schemaName?: string }
  ): KnexColumnBuilder {
    return this.#column("enum", trim([name, values, options]));
  }

  binary(name: string, length?: number): KnexColumnBuilder {
    return this.#column("binary", trim([name, length]));
  }

  specificType(name: string, type: string): KnexColumnBuilder {
    return this.#column("specificType", [name, type]);
  }

  /**
   * `created_at` and `updated_at`: `timestamp` columns when `useTimestamps` is true, otherwise `datetime`, not null with
   * a CURRENT_TIMESTAMP default when `defaultToNow` is true.
   */
  timestamps(
    useTimestamps?: boolean | { useTimestamps?: boolean; defaultToNow?: boolean; useCamelCase?: boolean },
    defaultToNow?: boolean,
    useCamelCase?: boolean
  ): void {
    if (typeof useTimestamps === "object" && useTimestamps !== null) {
      ({ useTimestamps, defaultToNow, useCamelCase } = useTimestamps);
    }
    const method = useTimestamps === true ? "timestamp" : "datetime";
    const createdAt = this[method](useCamelCase ? "createdAt" : "created_at");
    const updatedAt = this[method](useCamelCase ? "updatedAt" : "updated_at");
    if (defaultToNow === true) {
      createdAt.notNullable().defaultTo(CURRENT_TIMESTAMP);
      updatedAt.notNullable().defaultTo(CURRENT_TIMESTAMP);
    }
  }

  // Keys and indexes.

  index(columns: Columns, indexName?: string, options?: string | { indexType?: string; storageEngineIndexType?: string }): this {
    return this.#statement("index", trim([columns, indexName, options]));
  }

  unique(
    columns: Columns,
    indexName?: string | { indexName?: string; deferrable?: string; useConstraint?: boolean; storageEngineIndexType?: string }
  ): this {
    return this.#statement("unique", trim([columns, indexName]));
  }

  primary(columns: Columns, constraintName?: string | { constraintName?: string; deferrable?: string }): this {
    return this.#statement("primary", trim([columns, constraintName]));
  }

  /** `foreign("team_id").references("teams.id")`, or `.references("id").inTable("teams")`. */
  foreign(columns: Columns, keyName?: string): KnexForeignBuilder {
    const data: KnexForeignData = {
      column: typeof columns === "string" ? columns : [...columns],
      keyName,
    };
    this.statements.push({ grouping: "alterTable", method: "foreign", args: [data] });
    return new KnexForeignBuilder(data, this.dialect);
  }

  dropPrimary(constraintName?: string): this {
    return this.#statement("dropPrimary", trim([constraintName]));
  }

  dropUnique(columns: Columns, indexName?: string): this {
    return this.#statement("dropUnique", trim([columns, indexName]));
  }

  dropIndex(columns: Columns, indexName?: string): this {
    return this.#statement("dropIndex", trim([columns, indexName]));
  }

  dropForeign(columns: Columns, foreignKeyName?: string): this {
    return this.#statement("dropForeign", trim([columns, foreignKeyName]));
  }

  // MySQL table options, in createTable() only.

  #mysqlOption(name: "engine" | "charset" | "collate", value: string) {
    if (this.dialect !== "mysql" && this.dialect !== "mariadb") {
      throw new Error(`Tenora: ${name}() only works on MySQL and MariaDB.`);
    }
    if (this.method === "alter") throw new Error(`Tenora: ${name}() only works inside createTable().`);
    this.single[name] = value;
  }

  engine(value: string): void {
    this.#mysqlOption("engine", value);
  }

  charset(value: string): void {
    this.#mysqlOption("charset", value);
  }

  collate(value: string): void {
    this.#mysqlOption("collate", value);
  }

  // alterTable() only.

  dropColumn(...columns: string[] | [readonly string[]]): this {
    this.#alterOnly("dropColumn");
    return this.#statement("dropColumn", columns);
  }

  dropColumns(...columns: string[] | [readonly string[]]): this {
    this.#alterOnly("dropColumns");
    return this.#statement("dropColumn", columns);
  }

  renameColumn(from: string, to: string): this {
    this.#alterOnly("renameColumn");
    return this.#statement("renameColumn", [from, to]);
  }

  dropTimestamps(useCamelCase?: boolean): this {
    return this.dropColumns(useCamelCase === true ? ["createdAt", "updatedAt"] : ["created_at", "updated_at"]);
  }
}

/** Drops trailing undefined arguments, so the recorded arguments are the ones the caller passed. */
const trim = (args: unknown[]): unknown[] => {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end--;
  return args.slice(0, end);
};
