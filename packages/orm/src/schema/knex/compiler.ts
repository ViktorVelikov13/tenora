/**
 * The SQL Knex 3.3 writes for a schema change, statement for statement, so that migrations converted from 0.x build
 * exactly the schema the original files built. This is a port of Knex's schema compilers (`lib/schema/*compiler.js`
 * and the pg, mysql, mssql and sqlite3 dialects) for the methods the compatible blueprint offers, quirks included.
 * It writes SQL text directly: Kysely quotes and orders differently.
 *
 * Where Knex reads the database before it alters (a MySQL column rename, most SQLite alterations) the statement shows
 * the query Knex reports in toSQL() and carries a `run` that does the work.
 */
import type { Dialect } from "../../dialect";
import { RawSql, SqlIdentifier, SqlText, sql } from "../../sql";
import type { SchemaRunner } from "../runner";
import {
  type Clause,
  type ColumnDefinition,
  hasName,
  rebuildTable,
  sameName,
  type TableDefinition,
  writeColumn,
} from "../sqlite";
import {
  type KnexAlterStatement,
  KnexColumnBuilder,
  type KnexForeignData,
  KnexTableBuilder,
} from "./blueprint";

/** A statement as Knex's toSQL() reports it (`?` placeholders), with what Tenora runs for it. */
export type KnexStatement = {
  readonly sql: string;
  readonly bindings: readonly unknown[];
  readonly raw: RawSql;
  readonly run?: (runner: SchemaRunner) => Promise<void>;
};

/** Knex reads these from the connection config; MySQL tables are created with them. */
export type KnexCompatOptions = { readonly charset?: string; readonly collate?: string };

const text = (statement: string): KnexStatement => ({ sql: statement, bindings: [], raw: new RawSql([statement], []) });

const bound = (strings: string[], bindings: unknown[]): KnexStatement => ({
  sql: strings.join("?"),
  bindings,
  raw: new RawSql(strings, bindings),
});

const probe = (statement: KnexStatement, run: (runner: SchemaRunner) => Promise<void>): KnexStatement => ({
  ...statement,
  run,
});

const isMysql = (dialect: Dialect) => dialect === "mysql" || dialect === "mariadb";
const isObject = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null;

/** Knex's toNumber: parseInt, or the fallback. */
const toNumber = (value: unknown, fallback?: number) => {
  if (value === undefined || value === null) return fallback;
  const number = parseInt(String(value), 10);
  return Number.isNaN(number) ? fallback : number;
};

// Quoting, as each Knex client's wrapIdentifierImpl does it.
const wrapIdentifierImpl = (dialect: Dialect, value: string): string => {
  if (value === "*") return value;
  switch (dialect) {
    case "postgres": {
      const accessor = /(.*?)(\[[0-9]+\])/.exec(value);
      return accessor ? `"${accessor[1].replace(/"/g, '""')}"${accessor[2]}` : `"${value.replace(/"/g, '""')}"`;
    }
    case "mssql":
      return `[${value.replace(/[[\]]+/g, "")}]`;
    default:
      // mysql, mariadb and sqlite all use backticks in Knex.
      return `\`${value.replace(/`/g, "``")}\``;
  }
};

const wrapAsIdentifier = (dialect: Dialect, value: string) => wrapIdentifierImpl(dialect, (value || "").trim());

const aliasIndex = (value: string) => {
  for (let i = value.indexOf(" "); i !== -1; i = value.indexOf(" ", i + 1)) {
    if (i + 3 < value.length && (value.charCodeAt(i + 1) | 32) === 97 && (value.charCodeAt(i + 2) | 32) === 115 && value[i + 3] === " ") {
      return i;
    }
  }
  return -1;
};

const wrapString = (dialect: Dialect, value: string): string => {
  const as = aliasIndex(value);
  if (as !== -1) {
    return `${wrapString(dialect, value.slice(0, as))} as ${wrapAsIdentifier(dialect, value.slice(as + 4))}`;
  }
  const segments = value.split(".");
  if (segments.length === 1) return wrapAsIdentifier(dialect, value);
  const last = segments.pop()!;
  return [
    wrapString(dialect, segments[0].trim()),
    ...segments.slice(1).map((segment) => wrapAsIdentifier(dialect, segment)),
    wrapAsIdentifier(dialect, last),
  ].join(".");
};

export const wrap = (dialect: Dialect, value: unknown): string => {
  if (value instanceof RawSql) return rawText(dialect, value);
  if (typeof value === "number") return String(value);
  return wrapString(dialect, String(value));
};

const columnize = (dialect: Dialect, target: unknown): string =>
  Array.isArray(target) ? target.map((column) => wrap(dialect, column)).join(", ") : wrap(dialect, target);

// String literals, as each client's _escapeBinding writes them.
const ESCAPES: Record<string, string> = {
  "\0": "\\0",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\r": "\\r",
  "\x1a": "\\Z",
  '"': '\\"',
  "'": "\\'",
  "\\": "\\\\",
};

export const escapeString = (dialect: Dialect, value: string): string => {
  if (dialect === "postgres") {
    const escaped = value.replace(/'/g, "''").replace(/\\/g, "\\\\");
    return value.includes("\\") ? `E'${escaped}'` : `'${escaped}'`;
  }
  if (isMysql(dialect)) return `'${value.replace(/[\0\b\t\n\r\x1a"'\\]/g, (c) => ESCAPES[c])}'`;
  return `'${value.replace(/'/g, "''")}'`;
};

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

const escapeValue = (dialect: Dialect, value: unknown): string => {
  if (value === undefined || value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Date) {
    const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`;
    return escapeString(dialect, date);
  }
  if (typeof value === "string") return escapeString(dialect, value);
  throw new Error(`Tenora: a ${typeof value} cannot be written into DDL.`);
};

/** A `sql` fragment as Knex's raw().toQuery() would write it: values inlined, identifiers quoted. */
const rawText = (dialect: Dialect, raw: RawSql): string =>
  raw.strings.reduce((out, part, index) => {
    if (index === 0) return part;
    const value = raw.values[index - 1];
    const inlined =
      value instanceof SqlIdentifier
        ? wrap(dialect, value.name)
        : value instanceof SqlText
          ? value.text
          : value instanceof RawSql
            ? rawText(dialect, value)
            : escapeValue(dialect, value);
    return out + inlined + part;
  }, "");

/** Knex's formatDefault. */
const formatDefault = (dialect: Dialect, value: unknown, type: string): string => {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (value instanceof RawSql) return rawText(dialect, value);
  if (type === "bool") {
    const truthy = value === "false" ? false : Boolean(value);
    return `'${truthy ? 1 : 0}'`;
  }
  if ((type === "json" || type === "jsonb") && isObject(value)) return `'${JSON.stringify(value)}'`;
  return escapeString(dialect, String(value));
};

/** Knex's default name for an index or key: `users_email_unique`. */
const indexCommand = (dialect: Dialect, type: string, tableName: string, columns: unknown): string => {
  const list = Array.isArray(columns) ? columns : columns ? [columns] : [];
  const table = tableName.replace(/\.|-/g, "_");
  return wrap(dialect, `${table}_${list.join("_")}_${type}`.toLowerCase());
};

const normalizeArray = (args: unknown[]): unknown[] => (Array.isArray(args[0]) ? args[0] : args);

const MSSQL_DROP_DEFAULT = (schema: string, table: string, column: string) => `
              DECLARE @constraint varchar(100) = (SELECT default_constraints.name
                                                  FROM sys.all_columns
                                                  INNER JOIN sys.tables
                                                    ON all_columns.object_id = tables.object_id
                                                  INNER JOIN sys.schemas
                                                    ON tables.schema_id = schemas.schema_id
                                                  INNER JOIN sys.default_constraints
                                                    ON all_columns.default_object_id = default_constraints.object_id
                                                  WHERE schemas.name = '${schema}'
                                                  AND tables.name = '${table}'
                                                  AND all_columns.name = '${column}')

              IF @constraint IS NOT NULL EXEC('ALTER TABLE ${table} DROP CONSTRAINT ' + @constraint)`;

/** One column, compiled as Knex's ColumnCompiler and its dialect subclasses do. */
class ColumnCompiler {
  readonly type: string;
  readonly isIncrements: boolean;
  readonly additional: KnexStatement[] = [];
  #columnType: string | undefined;

  constructor(
    readonly table: TableCompiler,
    readonly builder: KnexColumnBuilder
  ) {
    this.type = builder.type.toLowerCase();
    this.isIncrements = this.type.includes("increments");
  }

  get dialect() {
    return this.table.dialect;
  }

  get modified() {
    return this.builder.modifiers;
  }

  wrap(value: unknown) {
    return wrap(this.dialect, value);
  }

  toSQL(): KnexStatement[] {
    const column = text(this.compileColumn());
    return [column, ...this.additional];
  }

  compileColumn() {
    return `${this.wrap(this.columnName())} ${this.columnType()}${this.modifiers()}`;
  }

  columnName(): string {
    const name = this.builder.args[0];
    if (name) return String(name);
    if (!this.isIncrements) throw new Error(`Tenora: You did not specify a column name for the ${this.type} column.`);
    return "id";
  }

  columnType(): string {
    this.#columnType ??= this.#type(this.builder.args.slice(1));
    return this.#columnType;
  }

  #canBeAddPrimaryKey(options: { primaryKey?: unknown }) {
    return Boolean(options.primaryKey) && this.table.primaryKeyArgs().length === 0;
  }

  #type(args: unknown[]): string {
    const { dialect } = this;
    const [first, second] = args;
    switch (this.type) {
      case "increments":
      case "bigincrements": {
        const big = this.type === "bigincrements";
        const options = (first === undefined ? { primaryKey: true } : first) as { primaryKey?: unknown };
        const key = this.#canBeAddPrimaryKey(options);
        if (dialect === "postgres") return `${big ? "bigserial" : "serial"}${key ? " primary key" : ""}`;
        if (isMysql(dialect)) return `${big ? "bigint" : "int"} unsigned not null${key ? " auto_increment primary key" : ""}`;
        if (dialect === "mssql") return `${big ? "bigint" : "int"} identity(1,1) not null${key ? " primary key" : ""}`;
        return "integer not null primary key autoincrement";
      }
      case "integer":
        if (isMysql(dialect)) return first ? `int(${toNumber(first, 11)})` : "int";
        return dialect === "mssql" ? "int" : "integer";
      case "biginteger":
        return "bigint";
      case "smallint":
        return dialect === "sqlite" ? "integer" : "smallint";
      case "tinyint":
        if (dialect === "postgres") return "smallint";
        if (isMysql(dialect)) return first ? `tinyint(${toNumber(first, 1)})` : "tinyint";
        return "tinyint";
      case "varchar":
        return `${dialect === "mssql" ? "nvarchar" : "varchar"}(${toNumber(first, 255)})`;
      case "text":
        if (dialect === "mssql") return "nvarchar(max)";
        if (isMysql(dialect)) {
          if (first === "medium" || first === "mediumtext") return "mediumtext";
          if (first === "long" || first === "longtext") return "longtext";
        }
        return "text";
      case "bool":
        return dialect === "mssql" ? "bit" : "boolean";
      case "date":
        return "date";
      case "datetime":
      case "timestamp":
        return this.#dateTime(args);
      case "time":
        if (isMysql(dialect)) {
          const precision = isObject(first) ? first.precision : first;
          return typeof precision === "number" ? `time(${precision})` : "time";
        }
        return "time";
      case "decimal":
        if (dialect === "sqlite") return "float";
        if (first === null) {
          if (dialect === "postgres") return "decimal";
          throw new Error("Tenora: Specifying no precision on decimal columns is not supported for that SQL dialect.");
        }
        return `decimal(${toNumber(first, 8)}, ${toNumber(second, 2)})`;
      case "floating":
        if (dialect === "postgres") return "real";
        if (dialect === "mssql" || dialect === "sqlite") return "float";
        return `float(${toNumber(first, 8)}, ${toNumber(second, 2)})`;
      case "double":
        if (dialect === "postgres") return "double precision";
        if (isMysql(dialect)) return first ? `double(${toNumber(first, 8)}, ${toNumber(second, 2)})` : "double";
        return "float";
      case "json":
        if (dialect === "postgres") return first ? "jsonb" : "json";
        return dialect === "mssql" ? "nvarchar(max)" : "json";
      case "jsonb":
        if (dialect === "postgres") return "jsonb";
        return dialect === "mssql" ? "nvarchar(max)" : "json";
      case "uuid": {
        const options = (first ?? {}) as { useBinaryUuid?: boolean; primaryKey?: boolean };
        if (dialect === "postgres") return `uuid${this.#canBeAddPrimaryKey(first === undefined ? { primaryKey: false } : options) ? " primary key" : ""}`;
        if (dialect === "mssql") return options.useBinaryUuid ? "binary(16)" : "uniqueidentifier";
        return options.useBinaryUuid ? "binary(16)" : "char(36)";
      }
      case "enu":
        return this.#enum(first as readonly string[], second as Record<string, any> | undefined);
      case "binary":
        if (dialect === "postgres") return "bytea";
        if (isMysql(dialect)) return first ? `varbinary(${toNumber(first)})` : "blob";
        if (dialect === "mssql") return first ? `varbinary(${toNumber(first)})` : "varbinary(max)";
        return "blob";
      case "specifictype":
        return String(first);
      default:
        throw new Error(`Tenora: the Knex-compatible blueprint has no ${this.builder.type}() column.`);
    }
  }

  #dateTime(args: unknown[]): string {
    const { dialect } = this;
    const [first, second] = args;
    if (dialect === "postgres") {
      let useTz: unknown;
      let precision = second;
      if (isObject(first)) ({ useTz, precision } = first);
      else useTz = !(first ?? false);
      useTz = typeof useTz === "boolean" ? useTz : true;
      const suffix = precision !== undefined && precision !== null ? `(${String(precision)})` : "";
      return `${useTz ? "timestamptz" : "timestamp"}${suffix}`;
    }
    if (isMysql(dialect)) {
      const precision = isObject(first) ? first.precision : first;
      return typeof precision === "number" ? `${this.type}(${precision})` : this.type;
    }
    if (dialect === "mssql") {
      if (this.type === "datetime") return "datetime2";
      const useTz = isObject(first) ? (first.useTz ?? false) : false;
      return useTz ? "datetimeoffset" : "datetime2";
    }
    return "datetime";
  }

  #enum(allowed: readonly string[], options: Record<string, any> = {}): string {
    const { dialect } = this;
    if (dialect === "mssql") return "nvarchar(100)";
    if (isMysql(dialect)) return `enum('${allowed.join("', '")}')`;
    if (dialect === "postgres" && options.useNative) {
      const schemaName = options.schemaName;
      const enumName = `${schemaName ? `"${schemaName}".` : ""}"${options.enumName}"`;
      if (!options.existingType) {
        this.table.unshift(text(`create type ${enumName} as enum ('${allowed.join("', '")}')`));
      }
      return enumName;
    }
    return `text check (${this.wrap(this.builder.args[0])} in ('${allowed.join("', '")}'))`;
  }

  modifiers(): string {
    const order: readonly string[] = isMysql(this.dialect) ? ["unsigned", "nullable", "defaultTo"] : ["nullable", "defaultTo"];
    const parts: string[] = [];
    if (this.isIncrements) return "";
    for (const name of order) {
      const args = this.modified[name as keyof KnexColumnBuilder["modifiers"]];
      if (!args) continue;
      const value =
        name === "unsigned" ? "unsigned" : name === "nullable" ? this.nullable(args[0]) : this.defaultTo(args[0], args[1]);
      if (value) parts.push(value);
    }
    return parts.length ? ` ${parts.join(" ")}` : "";
  }

  nullable(nullable: unknown) {
    return nullable === false ? "not null" : "null";
  }

  defaultTo(value: unknown, options?: unknown): string | undefined {
    const { dialect } = this;
    if (isMysql(dialect)) {
      if (value === null || value === undefined) return undefined;
      if ((this.type === "json" || this.type === "jsonb") && isObject(value) && !(value instanceof RawSql)) {
        return `default ('${JSON.stringify(value)}')`;
      }
      const written = `default ${formatDefault(dialect, value, this.type)}`;
      return this.type !== "blob" && !this.type.includes("text") ? written : "";
    }
    const formatted = formatDefault(dialect, value, this.type);
    if (dialect === "mssql") {
      const given = isObject(options) ? options.constraintName : undefined;
      const constraintName =
        given !== undefined ? given : `${this.table.tableNameRaw}_${this.columnName()}_default`.toLowerCase();
      if (this.builder.method === "alter") {
        this.additional.push(
          text(
            `ALTER TABLE ${this.table.tableName()} ADD CONSTRAINT ${this.wrap(constraintName)} DEFAULT ${formatted} FOR ${this.wrap(this.columnName())}`
          )
        );
        return "";
      }
      return constraintName ? `CONSTRAINT ${this.wrap(constraintName)} DEFAULT ${formatted}` : `DEFAULT ${formatted}`;
    }
    return `default ${formatted}`;
  }
}

/** A table, compiled as Knex's TableCompiler and its dialect subclasses do. */
class TableCompiler {
  readonly sequence: KnexStatement[] = [];
  readonly columns: KnexColumnBuilder[];
  alterStatements: KnexAlterStatement[];
  forCreate = false;

  constructor(
    readonly dialect: Dialect,
    readonly builder: KnexTableBuilder,
    readonly options: KnexCompatOptions
  ) {
    this.columns = builder.statements.flatMap((statement) => (statement.grouping === "columns" ? [statement.builder] : []));
    this.alterStatements = builder.statements.filter(
      (statement): statement is KnexAlterStatement => statement.grouping === "alterTable"
    );
  }

  get tableNameRaw() {
    return this.builder.tableName;
  }

  get lowerCase() {
    return this.dialect !== "mssql";
  }

  tableName() {
    return wrap(this.dialect, this.tableNameRaw);
  }

  wrap(value: unknown) {
    return wrap(this.dialect, value);
  }

  columnize(value: unknown) {
    return columnize(this.dialect, value);
  }

  push(statement: KnexStatement | string) {
    this.sequence.push(typeof statement === "string" ? text(statement) : statement);
  }

  unshift(statement: KnexStatement) {
    this.sequence.unshift(statement);
  }

  primaryKeyArgs(): unknown[] {
    return this.alterStatements.filter((statement) => statement.method === "primary").flatMap((statement) => statement.args).flat();
  }

  #compilers(method: "add" | "alter") {
    return this.columns.filter((column) => column.method === method).map((column) => new ColumnCompiler(this, column));
  }

  toSQL(): KnexStatement[] {
    if (this.builder.method === "alter") this.alter();
    else this.create(this.builder.method === "createIfNot");
    return this.sequence;
  }

  create(ifNot: boolean) {
    const columns = this.#compilers("add").map((compiler) => compiler.toSQL());
    const types = columns.map(([first]) => first.sql);
    if (this.dialect === "mssql") this.#alterTableForCreate(types);
    this.#createQuery(types, ifNot);
    this.#columnQueries(columns);
    this.#alterTable();
  }

  alter() {
    const addCompilers = this.#compilers("add");
    const addColumns = addCompilers.map((compiler) => compiler.toSQL());
    const alterCompilers = this.#compilers("alter");
    const alterColumns = alterCompilers.map((compiler) => compiler.toSQL());
    this.#addColumns(addColumns.map(([first]) => first.sql));
    this.#alterColumns(
      alterColumns.map(([first]) => first.sql),
      alterCompilers
    );
    this.#columnQueries(addColumns);
    this.#columnQueries(alterColumns);
    this.#alterTable();
  }

  /** SQL Server writes foreign and primary keys into CREATE TABLE. */
  #alterTableForCreate(types: string[]) {
    this.forCreate = true;
    const saved = this.sequence.splice(0);
    const remaining: KnexAlterStatement[] = [];
    for (const statement of this.alterStatements) {
      if (statement.method !== "foreign" && statement.method !== "primary") {
        remaining.push(statement);
        continue;
      }
      this.sequence.length = 0;
      this.#call(statement);
      if (this.sequence[0]) types.push(this.sequence[0].sql);
    }
    this.alterStatements = remaining;
    this.sequence.splice(0, this.sequence.length, ...saved);
    this.forCreate = false;
  }

  #createQuery(types: string[], ifNot: boolean) {
    const { dialect } = this;
    const table = this.tableName();
    if (dialect === "mssql") {
      const create = `CREATE TABLE ${table} (${types.join(", ")})`;
      this.push(ifNot ? `if object_id('${table}', 'U') is null ${create}` : create);
      return;
    }
    const createStatement = ifNot ? "create table if not exists " : "create table ";
    if (dialect === "postgres") {
      this.push(`${createStatement}${table} (${types.join(", ")}${this.#primaryKeys() ?? ""})`);
    } else if (isMysql(dialect)) {
      let statement = `${createStatement}${table} (${types.join(", ")}${this.#primaryKeys() ?? ""})`;
      const charset = this.builder.single.charset || this.options.charset || "";
      const collation = this.builder.single.collate || this.options.collate || "";
      const engine = this.builder.single.engine || "";
      if (charset) statement += ` default character set ${charset}`;
      if (collation) statement += ` collate ${collation}`;
      if (engine) statement += ` engine = ${engine}`;
      this.push(statement);
    } else {
      this.push(`${createStatement}${table} (${types.join(", ")}${this.#sqliteForeignKeys()}${this.#primaryKeys() ?? ""})`);
    }
  }

  #primaryKeys(): string | undefined {
    const keys = this.alterStatements.filter((statement) => statement.method === "primary");
    if (!keys.length || !keys[0].args.length) return undefined;
    const [columns, name] = keys[0].args;
    if (this.dialect === "postgres") {
      let constraintName = name || "";
      let deferrable: unknown;
      if (isObject(constraintName)) ({ constraintName, deferrable } = constraintName);
      const key = this.wrap(constraintName ? constraintName : `${this.tableNameRaw}_pkey`);
      return `, constraint ${key} primary key (${this.columnize(columns)})${deferrable ? ` deferrable initially ${String(deferrable)}` : ""}`;
    }
    const constraintName = name ? ` constraint ${this.wrap(name)}` : "";
    if (isMysql(this.dialect)) {
      this.#unshiftIncrements(columns, ["increments"]);
      this.#unshiftIncrements(columns, ["bigincrements"]);
      return `,${constraintName} primary key (${this.columnize(columns)})`;
    }
    // SQLite: an autoincrement column is the primary key already, so the others become a unique key.
    const needUnique = this.columns.some((column) => column.type === "increments");
    return `,${constraintName} ${needUnique ? "unique" : "primary key"} (${this.columnize(columns)})`;
  }

  /**
   * MySQL puts increments columns first in a composite primary key. Knex changes the recorded column list in place,
   * so the later primary() call sees it changed too; a single column name is a string there, and Knex fails on it.
   */
  #unshiftIncrements(columns: unknown, types: readonly string[]) {
    for (const name of this.#incrementsColumns(types)) {
      if (Array.isArray(columns)) {
        if (!columns.includes(name)) columns.unshift(name);
      } else if (typeof columns === "string" && !columns.includes(name)) {
        throw new Error(
          `Tenora: primary("${columns}") next to increments column "${name}" fails in Knex too; pass the primary key columns as an array.`
        );
      }
    }
  }

  /** Knex compares the type as written, so only increments() and bigincrements() count here, not bigIncrements(). */
  #incrementsColumns(types: readonly string[]): string[] {
    return this.columns.filter((column) => types.includes(column.type)).map((column) => column.args[0] as string);
  }

  #sqliteForeignKeys(): string {
    let out = "";
    for (const statement of this.alterStatements) {
      if (statement.method !== "foreign") continue;
      const foreign = statement.args[0] as KnexForeignData;
      const name = foreign.keyName ? ` constraint ${this.wrap(foreign.keyName)}` : "";
      out += `,${name} foreign key(${this.columnize(foreign.column)}) references ${this.wrap(foreign.inTable)}(${this.columnize(foreign.references)})`;
      if (foreign.onDelete) out += ` on delete ${foreign.onDelete}`;
      if (foreign.onUpdate) out += ` on update ${foreign.onUpdate}`;
    }
    return out;
  }

  #columnQueries(columns: KnexStatement[][]) {
    for (const [, ...rest] of columns) for (const statement of rest) this.push(statement);
  }

  #addColumns(types: string[]) {
    if (!types.length) return;
    const table = this.tableName();
    switch (this.dialect) {
      case "mssql":
        this.push(`ALTER TABLE ${table} ADD ${types.join(", ")}`);
        return;
      case "sqlite":
        for (const type of types) this.push(`alter table ${table} add column ${type}`);
        return;
      default: {
        const prefix = this.dialect === "postgres" ? "add column " : "add ";
        this.push(`alter table ${table} ${types.map((type) => prefix + type).join(", ")}`);
      }
    }
  }

  #alterColumns(types: string[], compilers: ColumnCompiler[]) {
    const table = this.tableName();
    switch (this.dialect) {
      case "postgres":
        if (types.length) for (const compiler of compilers) this.#alterPostgresColumn(compiler);
        return;
      case "mssql":
        for (const compiler of compilers) {
          if (compiler.modified.defaultTo) this.push(MSSQL_DROP_DEFAULT("dbo", this.tableNameRaw, compiler.columnName()));
        }
        for (const type of types) this.push(`ALTER TABLE ${table} ALTER COLUMN ${type}`);
        return;
      case "sqlite": {
        if (!types.length) return;
        const changes = compilers.map((compiler) => ({
          name: compiler.columnName(),
          type: compiler.columnType(),
          defaultTo: compiler.modified.defaultTo
            ? formatDefault(this.dialect, compiler.modified.defaultTo[0], compiler.type)
            : null,
          notNull: compiler.modified.nullable?.[0] === false,
        }));
        this.#rebuild((definition) => alterColumns(definition, changes));
        return;
      }
      default:
        if (types.length) this.push(`alter table ${table} ${types.map((type) => `modify ${type}`).join(", ")}`);
    }
  }

  /** Postgres changes a column in up to five statements. */
  #alterPostgresColumn(compiler: ColumnCompiler) {
    const table = this.tableName();
    const type = compiler.columnType();
    const column = wrapIdentifierImpl("postgres", compiler.columnName());
    this.push(`alter table ${table} alter column ${column} drop default`);
    const { alterNullable, alterType } = compiler.builder;
    if (alterNullable) this.push(`alter table ${table} alter column ${column} drop not null`);
    if (alterType) {
      const cast = compiler.type === "enu" ? "::text::" : "::";
      this.push(`alter table ${table} alter column ${column} type ${type} using (${column}${cast}${type})`);
    }
    const defaultTo = compiler.modified.defaultTo;
    if (defaultTo) this.push(`alter table ${table} alter column ${column} set ${compiler.defaultTo(defaultTo[0], defaultTo[1])}`);
    if (alterNullable && compiler.modified.nullable?.[0] === false) {
      this.push(`alter table ${table} alter column ${column} set not null`);
    }
  }

  #alterTable() {
    for (const statement of this.alterStatements) this.#call(statement);
  }

  #call({ method, args }: KnexAlterStatement) {
    switch (method) {
      case "index":
        return this.#index(args[0], args[1] as string | undefined, args[2]);
      case "unique":
        return this.#unique(args[0], args[1]);
      case "primary":
        return this.#primary(args[0], args[1]);
      case "foreign":
        return this.#foreign(args[0] as KnexForeignData);
      case "dropIndex":
        return this.#dropIndex(args[0], args[1] as string | undefined);
      case "dropUnique":
        return this.#dropUnique(args[0], args[1] as string | undefined);
      case "dropForeign":
        return this.#dropForeign(args[0], args[1] as string | undefined);
      case "dropPrimary":
        return this.#dropPrimary(args[0] as string | undefined);
      case "dropColumn":
        return this.#dropColumn(args);
      case "renameColumn":
        return this.#renameColumn(args[0] as string, args[1] as string);
    }
  }

  #name(given: unknown, type: string, columns: unknown) {
    return given ? this.wrap(given) : indexCommand(this.dialect, type, this.tableNameRaw, columns);
  }

  #index(columns: unknown, indexName: string | undefined, options: unknown) {
    const { dialect } = this;
    const name = this.#name(indexName, "index", columns);
    const table = this.tableName();
    const list = this.columnize(columns);
    if (isObject(options) && options.predicate) throw new Error("Tenora: index predicates are not supported.");
    if (dialect === "postgres") {
      let indexType: unknown;
      let using: unknown;
      if (typeof options === "string") using = options;
      else if (isObject(options)) ({ indexType, storageEngineIndexType: using } = options);
      const unique = typeof indexType === "string" && indexType.toLowerCase() === "unique" ? " unique" : "";
      this.push(`create${unique} index ${name} on ${table}${using ? ` using ${String(using)}` : ""} (${list})`);
    } else if (isMysql(dialect)) {
      let indexType: unknown;
      let using: unknown;
      if (typeof options === "string") indexType = options;
      else if (isObject(options)) ({ indexType, storageEngineIndexType: using } = options);
      this.push(
        `alter table ${table} add${indexType ? ` ${String(indexType)}` : ""} index ${name}(${list})${using ? ` using ${String(using)}` : ""}`
      );
    } else if (dialect === "mssql") {
      this.push(`CREATE INDEX ${name} ON ${table} (${list})`);
    } else {
      this.push(`create index ${name} on ${table} (${list})`);
    }
  }

  #unique(columns: unknown, given: unknown) {
    const { dialect } = this;
    const table = this.tableName();
    let indexName = given;
    let deferrable: unknown;
    let useConstraint: unknown;
    let predicate: unknown;
    let using: unknown;
    if (isObject(indexName)) {
      ({ indexName, deferrable, useConstraint, predicate, storageEngineIndexType: using } = indexName);
    }
    if (predicate) throw new Error("Tenora: unique index predicates are not supported.");
    const name = this.#name(indexName, "unique", columns);
    if (dialect === "postgres") {
      if (useConstraint === undefined) useConstraint = true;
      if (!useConstraint && deferrable && deferrable !== "not deferrable") {
        throw new Error("Tenora: postgres cannot create deferrable index");
      }
      const suffix = deferrable ? ` deferrable initially ${String(deferrable)}` : "";
      this.push(
        useConstraint
          ? `alter table ${table} add constraint ${name} unique (${this.columnize(columns)})${suffix}`
          : `create unique index ${name} on ${table} (${this.columnize(columns)})`
      );
    } else if (isMysql(dialect)) {
      this.push(`alter table ${table} add unique ${name}(${this.columnize(columns)})${using ? ` using ${String(using)}` : ""}`);
    } else if (dialect === "mssql") {
      const list = Array.isArray(columns) ? columns : [columns];
      this.push(
        useConstraint
          ? `ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE (${this.columnize(list)})`
          : `CREATE UNIQUE INDEX ${name} ON ${table} (${this.columnize(list)}) WHERE ${list
              .map((column) => `${this.columnize(column)} IS NOT NULL`)
              .join(" AND ")}`
      );
    } else {
      this.push(`create unique index ${name} on ${table} (${this.columnize(columns)})`);
    }
  }

  #primary(columns: unknown, given: unknown) {
    const { dialect } = this;
    const table = this.tableName();
    let constraintName = given;
    let deferrable: unknown;
    if (isObject(constraintName)) ({ constraintName, deferrable } = constraintName);
    const creating = this.builder.method !== "alter";
    if (dialect === "sqlite") {
      if (creating) return;
      const list = (Array.isArray(columns) ? columns : [columns]).map(String);
      const name = constraintName as string | undefined;
      this.#rebuild((definition) => setPrimaryKey(definition, list, name));
      return;
    }
    const name = this.wrap(constraintName ? constraintName : `${this.tableNameRaw}_pkey`);
    if (dialect === "postgres") {
      if (!creating) {
        const suffix = deferrable ? ` deferrable initially ${String(deferrable)}` : "";
        this.push(`alter table ${table} add constraint ${name} primary key (${this.columnize(columns)})${suffix}`);
      }
      return;
    }
    if (dialect === "mssql") {
      this.push(
        this.forCreate
          ? `CONSTRAINT ${name} PRIMARY KEY (${this.columnize(columns)})`
          : `ALTER TABLE ${table} ADD CONSTRAINT ${name} PRIMARY KEY (${this.columnize(columns)})`
      );
      return;
    }
    // MySQL
    this.#unshiftIncrements(columns, ["increments"]);
    this.#unshiftIncrements(columns, ["bigincrements"]);
    const increments = this.#incrementsColumns(["increments"]);
    const bigIncrements = this.#incrementsColumns(["bigincrements"]);
    if (!creating) this.push(`alter table ${table} add primary key ${name}(${this.columnize(columns)})`);
    if (increments.length) {
      this.push(`alter table ${table} modify column ${this.columnize(increments)} int unsigned not null auto_increment`);
    }
    if (bigIncrements.length) {
      this.push(`alter table ${table} modify column ${this.columnize(bigIncrements)} bigint unsigned not null auto_increment`);
    }
  }

  #foreign(foreign: KnexForeignData) {
    const { dialect } = this;
    if (dialect === "sqlite") {
      if (this.builder.method === "alter") {
        const info = { ...foreign };
        this.#rebuild((definition) => addForeignKey(definition, info));
      }
      return;
    }
    if (!foreign.inTable || !foreign.references) return;
    const keyName = foreign.keyName
      ? this.wrap(foreign.keyName)
      : indexCommand(dialect, "foreign", this.tableNameRaw, foreign.column);
    const column = this.columnize(foreign.column);
    const references = this.columnize(foreign.references);
    const inTable = this.wrap(foreign.inTable);
    const lower = this.lowerCase;
    const onUpdate = foreign.onUpdate ? `${lower ? " on update " : " ON UPDATE "}${foreign.onUpdate}` : "";
    const onDelete = foreign.onDelete ? `${lower ? " on delete " : " ON DELETE "}${foreign.onDelete}` : "";
    const deferrable = foreign.deferrable
      ? lower
        ? ` deferrable initially ${foreign.deferrable.toLowerCase()} `
        : ` DEFERRABLE INITIALLY ${foreign.deferrable.toUpperCase()} `
      : "";
    const prefix = this.forCreate ? "" : lower ? `alter table ${this.tableName()} add ` : `ALTER TABLE ${this.tableName()} ADD `;
    this.push(
      lower
        ? `${prefix}constraint ${keyName} foreign key (${column}) references ${inTable} (${references})${onUpdate}${onDelete}${deferrable}`
        : `${prefix}CONSTRAINT ${keyName} FOREIGN KEY (${column}) REFERENCES ${inTable} (${references})${onUpdate}${onDelete}${deferrable}`
    );
  }

  #dropIndex(columns: unknown, indexName: string | undefined) {
    const name = this.#name(indexName, "index", columns);
    const table = this.tableName();
    if (isMysql(this.dialect)) this.push(`alter table ${table} drop index ${name}`);
    else if (this.dialect === "mssql") this.push(`DROP INDEX ${name} ON ${table}`);
    else this.push(`drop index ${name}`);
  }

  #dropUnique(columns: unknown, indexName: string | undefined) {
    const name = this.#name(indexName, "unique", columns);
    const table = this.tableName();
    if (this.dialect === "postgres") this.push(`alter table ${table} drop constraint ${name}`);
    else if (isMysql(this.dialect)) this.push(`alter table ${table} drop index ${name}`);
    else if (this.dialect === "mssql") this.push(`DROP INDEX ${name} ON ${table}`);
    else this.push(`drop index ${name}`);
  }

  #dropForeign(columns: unknown, indexName: string | undefined) {
    const table = this.tableName();
    if (this.dialect === "sqlite") {
      const list = (Array.isArray(columns) ? columns : [columns]).map(String);
      this.#rebuild((definition) => dropForeignKeys(definition, list, indexName));
      return;
    }
    const name = this.#name(indexName, "foreign", columns);
    if (this.dialect === "postgres") this.push(`alter table ${table} drop constraint ${name}`);
    else if (isMysql(this.dialect)) this.push(`alter table ${table} drop foreign key ${name}`);
    else this.push(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
  }

  #dropPrimary(constraintName: string | undefined) {
    const table = this.tableName();
    const name = this.wrap(constraintName ? constraintName : `${this.tableNameRaw}_pkey`);
    if (this.dialect === "postgres") this.push(`alter table ${table} drop constraint ${name}`);
    else if (isMysql(this.dialect)) this.push(`alter table ${table} drop primary key`);
    else if (this.dialect === "mssql") this.push(`ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
    else this.#rebuild((definition) => dropPrimaryKey(definition, constraintName));
  }

  #dropColumn(args: unknown[]) {
    const columns = normalizeArray(args).map(String);
    const table = this.tableName();
    if (this.dialect === "sqlite") {
      this.#rebuild((definition) => dropColumns(definition, columns), columns);
      return;
    }
    if (this.dialect === "mssql") {
      for (const column of columns) this.push(MSSQL_DROP_DEFAULT("dbo", this.tableNameRaw, column));
      this.push(`ALTER TABLE ${table} DROP COLUMN ${columns.map((column) => this.wrap(column)).join(", ")}`);
      return;
    }
    const prefix = this.dialect === "postgres" ? "drop column " : "drop ";
    this.push(`alter table ${table} ${columns.map((column) => prefix + this.wrap(column)).join(", ")}`);
  }

  #renameColumn(from: string, to: string) {
    const table = this.tableName();
    if (this.dialect === "mssql") {
      this.push(bound(["exec sp_rename ", ", ", ", 'COLUMN'"], [`${table}.${from}`, to]));
    } else if (isMysql(this.dialect)) {
      this.push(
        probe(bound([`show full fields from ${table} where field = `, ""], [from]), (runner) =>
          mysqlRenameColumn(runner, this.tableNameRaw, from, to)
        )
      );
    } else {
      this.push(`alter table ${table} rename ${this.wrap(from)} to ${this.wrap(to)}`);
    }
  }

  /** A SQLite change Knex makes by rebuilding the table; toSQL() shows the pragma Knex starts with. */
  #rebuild(change: (definition: TableDefinition) => TableDefinition, dropped?: readonly string[]) {
    const tableName = this.tableNameRaw;
    this.push(
      probe(text(`PRAGMA table_info(${this.tableName()})`), (runner) =>
        rebuildTable(runner, tableName, change, { dropped, indexes: "shrink", keepTriggers: false })
      )
    );
  }
}

// What Knex's SQLite rebuild (lib/dialects/sqlite3/schema/ddl.js) does to the definition. New parts are written with
// Knex's backticks.

const tick = (name: string) => wrapIdentifierImpl("sqlite", name);

type ColumnChange = { name: string; type: string; defaultTo: string | null; notNull: boolean };

/** `.alter()`: a new type, default and NOT NULL; other constraints stay, a NULL constraint only when nullable. */
const alterColumns = (definition: TableDefinition, changes: readonly ColumnChange[]): TableDefinition => ({
  ...definition,
  columns: definition.columns.map((column) => {
    const change = changes.find((candidate) => sameName(candidate.name, column.name));
    if (!change) return column;
    const kept = column.clauses.filter(
      (clause) => clause.kind !== "default" && clause.kind !== "notnull" && !(change.notNull && clause.kind === "null")
    );
    const added: Clause[] = [
      ...(change.notNull ? [{ kind: "notnull", text: "NOT NULL" } as const] : []),
      ...(change.defaultTo !== null ? [{ kind: "default", text: `DEFAULT ${change.defaultTo}` } as const] : []),
    ];
    return rewritten(column, change.type, [...kept, ...added]);
  }),
});

const rewritten = (column: ColumnDefinition, type: string, clauses: Clause[]): ColumnDefinition => ({
  ...column,
  type,
  clauses,
  text: writeColumn(column.nameText, type, clauses),
});

/** dropColumn(): the columns go, with the primary, unique and foreign keys that use them. */
const dropColumns = (definition: TableDefinition, columns: readonly string[]): TableDefinition => {
  const remaining = definition.columns.filter((column) => !hasName(columns, column.name));
  if (!remaining.length) throw new Error("Tenora: Unable to drop last column from table");
  return {
    ...definition,
    columns: remaining,
    constraints: definition.constraints.filter((constraint) =>
      constraint.kind === "primary" || constraint.kind === "unique" || constraint.kind === "foreign"
        ? constraint.columns.every((column) => column === undefined || !hasName(columns, column))
        : true
    ),
  };
};

/**
 * dropForeign(): removes the table's FOREIGN KEY constraints by name, or those on the columns. Knex leaves a key
 * written inside a column definition in place, and so does this.
 */
const dropForeignKeys = (definition: TableDefinition, columns: readonly string[], name?: string): TableDefinition => ({
  ...definition,
  constraints: definition.constraints.filter((constraint) => {
    if (constraint.kind !== "foreign") return true;
    if (name) return !constraint.name || !sameName(constraint.name, name);
    return constraint.columns.every((column) => !hasName(columns, column));
  }),
});

/** primary() on an existing table: replaces the table's PRIMARY KEY constraint (a column's own stays, as in Knex). */
const setPrimaryKey = (definition: TableDefinition, columns: readonly string[], name?: string): TableDefinition => ({
  ...definition,
  constraints: [
    ...definition.constraints.filter((constraint) => constraint.kind !== "primary"),
    {
      kind: "primary",
      name,
      columns: [...columns],
      text: `${name ? `CONSTRAINT ${tick(name)} ` : ""}PRIMARY KEY (${columns.map(tick).join(", ")})`,
    },
  ],
});

const dropPrimaryKey = (definition: TableDefinition, name?: string): TableDefinition => ({
  ...definition,
  constraints: definition.constraints.filter(
    (constraint) => constraint.kind !== "primary" || (name !== undefined && (!constraint.name || !sameName(constraint.name, name)))
  ),
});

const addForeignKey = (definition: TableDefinition, foreign: KnexForeignData): TableDefinition => {
  const columns = (Array.isArray(foreign.column) ? foreign.column : [foreign.column]).map(String);
  const references = (Array.isArray(foreign.references) ? foreign.references : [foreign.references]).map(String);
  const parts = [
    foreign.keyName ? `CONSTRAINT ${tick(foreign.keyName)} ` : "",
    `FOREIGN KEY (${columns.map(tick).join(", ")}) REFERENCES ${tick(String(foreign.inTable))} (${references.map(tick).join(", ")})`,
    foreign.onDelete ? ` ON DELETE ${foreign.onDelete}` : "",
    foreign.onUpdate ? ` ON UPDATE ${foreign.onUpdate}` : "",
  ];
  return {
    ...definition,
    constraints: [
      ...definition.constraints,
      {
        kind: "foreign",
        name: foreign.keyName,
        columns,
        references: { table: String(foreign.inTable), columns: references },
        text: parts.join(""),
      },
    ],
  };
};

const field = (row: Record<string, unknown>, name: string) =>
  row[name] ?? row[name.toLowerCase()] ?? Object.entries(row).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

/**
 * Knex renames a MySQL column with CHANGE, rebuilding its definition from SHOW FULL FIELDS, after dropping every
 * foreign key that references the table, which it then adds back.
 */
const mysqlRenameColumn = async (runner: SchemaRunner, table: string, from: string, to: string) => {
  const dialect = runner.dialect;
  const quoted = wrap(dialect, table);
  const [column] = await runner.query(sql`show full fields from ${sql.raw(quoted)} where field = ${from}`);
  if (!column) throw new Error(`Tenora: table "${table}" has no column "${from}".`);
  const refs = await runner.query(
    sql`SELECT KCU.CONSTRAINT_NAME, KCU.TABLE_NAME, KCU.COLUMN_NAME, KCU.REFERENCED_TABLE_NAME, KCU.REFERENCED_COLUMN_NAME, RC.UPDATE_RULE, RC.DELETE_RULE FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS KCU JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS RC USING(CONSTRAINT_NAME) WHERE KCU.REFERENCED_TABLE_NAME = ${table} AND KCU.CONSTRAINT_SCHEMA = database() AND RC.CONSTRAINT_SCHEMA = database()`
  );
  // A composite key has a row per column; Knex fails on one, so this groups them instead.
  type Key = { name: string; table: string; columns: string[]; inTable: string; references: string[]; update: string; delete: string };
  const keys = new Map<string, Key>();
  for (const ref of refs) {
    const name = String(field(ref, "CONSTRAINT_NAME"));
    const owner = String(field(ref, "TABLE_NAME"));
    const id = JSON.stringify([owner, name]);
    const key = keys.get(id) ?? {
      name,
      table: owner,
      columns: [],
      inTable: String(field(ref, "REFERENCED_TABLE_NAME")),
      references: [],
      update: String(field(ref, "UPDATE_RULE")),
      delete: String(field(ref, "DELETE_RULE")),
    };
    const own = String(field(ref, "COLUMN_NAME"));
    const referenced = String(field(ref, "REFERENCED_COLUMN_NAME"));
    key.columns.push(own === from ? to : own);
    key.references.push(referenced === from ? to : referenced);
    keys.set(id, key);
  }
  const run = (statement: string) => runner.query(sql`${sql.raw(statement)}`);
  for (const key of keys.values()) {
    await run(`alter table ${wrap(dialect, key.table)} drop foreign key ${wrap(dialect, key.name)}`);
  }
  let change = `alter table ${quoted} change ${wrap(dialect, from)} ${wrap(dialect, to)} ${String(field(column, "Type"))}`;
  change += String(field(column, "Null")).toUpperCase() !== "YES" ? " NOT NULL" : " NULL";
  const defaultValue = field(column, "Default");
  if (defaultValue !== undefined && defaultValue !== null) change += ` DEFAULT '${String(defaultValue)}'`;
  const collation = field(column, "Collation");
  if (collation !== undefined && collation !== null) change += ` COLLATE '${String(collation)}'`;
  if (field(column, "Extra") === "auto_increment") change += " AUTO_INCREMENT";
  await run(change);
  for (const key of keys.values()) {
    await run(
      `alter table ${wrap(dialect, key.table)} add constraint ${wrap(dialect, key.name)} foreign key (${columnize(dialect, key.columns)}) references ${wrap(dialect, key.inTable)} (${columnize(dialect, key.references)}) ON UPDATE ${key.update} ON DELETE ${key.delete}`
    );
  }
};

export const compileKnexTable = (dialect: Dialect, builder: KnexTableBuilder, options: KnexCompatOptions): KnexStatement[] =>
  new TableCompiler(dialect, builder, options).toSQL();

export const compileKnexDropTable = (dialect: Dialect, table: string, ifExists: boolean): KnexStatement => {
  const name = wrap(dialect, table);
  if (dialect === "mssql") return text(ifExists ? `if object_id('${name}', 'U') is not null DROP TABLE ${name}` : `DROP TABLE ${name}`);
  return text(`drop table ${ifExists ? "if exists " : ""}${name}`);
};

export const compileKnexRenameTable = (dialect: Dialect, from: string, to: string): KnexStatement => {
  if (dialect === "mssql") return bound(["exec sp_rename ", ", ", ""], [from, to]);
  if (isMysql(dialect)) return text(`rename table ${wrap(dialect, from)} to ${wrap(dialect, to)}`);
  return text(`alter table ${wrap(dialect, from)} rename to ${wrap(dialect, to)}`);
};

/** A `sql` fragment run as part of the schema change, shown as Knex shows `knex.schema.raw()`. */
export const compileKnexRaw = (dialect: Dialect, fragment: RawSql): KnexStatement => {
  const strings: string[] = [""];
  const bindings: unknown[] = [];
  const add = (raw: RawSql) => {
    raw.strings.forEach((part, index) => {
      if (index > 0) {
        const value = raw.values[index - 1];
        if (value instanceof SqlIdentifier) strings[strings.length - 1] += wrap(dialect, value.name);
        else if (value instanceof SqlText) strings[strings.length - 1] += value.text;
        else if (value instanceof RawSql) add(value);
        else {
          bindings.push(value);
          strings.push("");
        }
      }
      strings[strings.length - 1] += part;
    });
  };
  add(fragment);
  return { sql: strings.join("?"), bindings, raw: fragment };
};
