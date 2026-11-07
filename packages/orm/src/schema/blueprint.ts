/**
 * The table callback of `db.schema.create()` and `db.schema.table()`, in the style of Laravel's Blueprint.
 *
 * Unlike the query builder it records in place: a callback writes `t.string("email").unique()` and drops what it
 * returns, so the column has to be the one recorded.
 */
export type ColumnType =
  | "increments"
  | "bigIncrements"
  | "string"
  | "text"
  | "integer"
  | "bigInteger"
  | "smallInteger"
  | "boolean"
  | "decimal"
  | "float"
  | "double"
  | "date"
  | "dateTime"
  | "timestamp"
  | "time"
  | "json"
  | "uuid"
  | "binary"
  | "enum";

export type ReferentialAction = "cascade" | "set null" | "restrict" | "no action" | "set default";

export type ColumnSpec = {
  name: string;
  type: ColumnType;
  length?: number;
  precision?: number;
  scale?: number;
  values?: readonly string[];
  nullable: boolean;
  default?: { readonly value: unknown };
  useCurrent: boolean;
  unsigned: boolean;
  autoIncrement: boolean;
  change: boolean;
  /** fluent index modifiers: true, or the index name */
  unique?: true | string;
  index?: true | string;
  primary?: true;
};

export type ForeignKeySpec = {
  name?: string;
  columns: string[];
  on?: string;
  references: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
};

export type IndexCommand = { readonly type: "index" | "unique"; readonly columns: readonly string[]; readonly name?: string };
export type PrimaryCommand = { readonly type: "primary"; readonly columns: readonly string[]; readonly name?: string };

export type Command =
  | IndexCommand
  | PrimaryCommand
  | { readonly type: "foreign"; readonly key: ForeignKeySpec }
  | { readonly type: "dropColumn"; readonly columns: string[] }
  | { readonly type: "renameColumn"; readonly from: string; readonly to: string }
  | {
      readonly type: "dropIndex" | "dropUnique" | "dropForeign" | "dropPrimary";
      readonly name?: string;
      readonly columns?: readonly string[];
    };

/** Laravel's name for an index or key: `users_email_unique`, `posts_user_id_foreign`. */
export const indexName = (table: string, columns: readonly string[], type: string) =>
  `${table}_${columns.join("_")}_${type}`.toLowerCase().replace(/[-.]/g, "_");

/** A plain English plural, for constrained(): "team" → "teams", "category" → "categories", "box" → "boxes". */
const plural = (word: string) => {
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
};

const columnList = (columns: string | readonly string[]) => (typeof columns === "string" ? [columns] : [...columns]);

export class ForeignKeyDefinition {
  /** @internal */
  constructor(/** @internal */ readonly spec: ForeignKeySpec) {}

  references(columns: string | readonly string[]): this {
    this.spec.references = columnList(columns);
    return this;
  }

  on(table: string): this {
    this.spec.on = table;
    return this;
  }

  onDelete(action: ReferentialAction): this {
    this.spec.onDelete = action;
    return this;
  }

  onUpdate(action: ReferentialAction): this {
    this.spec.onUpdate = action;
    return this;
  }

  cascadeOnDelete(): this {
    return this.onDelete("cascade");
  }

  restrictOnDelete(): this {
    return this.onDelete("restrict");
  }

  nullOnDelete(): this {
    return this.onDelete("set null");
  }

  noActionOnDelete(): this {
    return this.onDelete("no action");
  }

  cascadeOnUpdate(): this {
    return this.onUpdate("cascade");
  }

  restrictOnUpdate(): this {
    return this.onUpdate("restrict");
  }

  nullOnUpdate(): this {
    return this.onUpdate("set null");
  }

  noActionOnUpdate(): this {
    return this.onUpdate("no action");
  }
}

export class ColumnDefinition {
  /** @internal */
  constructor(/** @internal */ readonly spec: ColumnSpec) {}

  nullable(value = true): this {
    this.spec.nullable = value;
    return this;
  }

  /** A value, or a `sql` fragment such as sql`CURRENT_TIMESTAMP`, which is written as is. */
  default(value: unknown): this {
    this.spec.default = { value };
    return this;
  }

  /** Defaults to the current time. */
  useCurrent(): this {
    this.spec.useCurrent = true;
    return this;
  }

  /** MySQL and MariaDB only; the others have no unsigned types. */
  unsigned(): this {
    this.spec.unsigned = true;
    return this;
  }

  autoIncrement(): this {
    this.spec.autoIncrement = true;
    return this;
  }

  unique(name?: string): this {
    this.spec.unique = name ?? true;
    return this;
  }

  index(name?: string): this {
    this.spec.index = name ?? true;
    return this;
  }

  primary(): this {
    this.spec.primary = true;
    return this;
  }

  /**
   * Changes an existing column to this definition, in `table()`. As in Laravel, the definition replaces the old one,
   * so modifiers to keep (nullable, default) have to be given again; indexes and foreign keys stay.
   */
  change(): this {
    this.spec.change = true;
    return this;
  }
}

export class ForeignIdColumnDefinition extends ColumnDefinition {
  /** @internal */
  constructor(
    spec: ColumnSpec,
    private readonly blueprint: Blueprint
  ) {
    super(spec);
  }

  /**
   * A foreign key to `table` (by default the plural of the column name without `_id`: `team_id` → `teams`) and its
   * `column`.
   */
  constrained(table?: string, column = "id", name?: string): ForeignKeyDefinition {
    const target = table ?? plural(this.spec.name.replace(new RegExp(`_${column}$`), ""));
    return this.blueprint.foreign(this.spec.name, name).references(column).on(target);
  }

  references(column: string): ForeignKeyDefinition {
    return this.blueprint.foreign(this.spec.name).references(column);
  }
}

export class Blueprint {
  /** @internal */ readonly columns: ColumnDefinition[] = [];
  /** @internal */ readonly commands: Command[] = [];

  /** @internal */
  constructor(
    readonly table: string,
    /** @internal */ readonly creating: boolean
  ) {}

  #add<C extends ColumnDefinition>(column: C): C {
    this.columns.push(column);
    return column;
  }

  #column(type: ColumnType, name: string, options: Partial<ColumnSpec> = {}): ColumnDefinition {
    return this.#add(new ColumnDefinition(this.#spec(type, name, options)));
  }

  #spec(type: ColumnType, name: string, options: Partial<ColumnSpec>): ColumnSpec {
    if (typeof name !== "string" || !name) throw new Error(`Tenora: ${type}() needs a column name.`);
    return { name, type, nullable: false, useCurrent: false, unsigned: false, autoIncrement: false, change: false, ...options };
  }

  #alterOnly(method: string) {
    if (this.creating) throw new Error(`Tenora: ${method}() only works in schema.table(), not in schema.create().`);
  }

  /** An auto-incrementing big integer primary key, `id` unless named. */
  id(name = "id"): ColumnDefinition {
    return this.bigIncrements(name);
  }

  increments(name: string): ColumnDefinition {
    return this.#column("increments", name, { autoIncrement: true, unsigned: true });
  }

  bigIncrements(name: string): ColumnDefinition {
    return this.#column("bigIncrements", name, { autoIncrement: true, unsigned: true });
  }

  string(name: string, length = 255): ColumnDefinition {
    return this.#column("string", name, { length });
  }

  text(name: string): ColumnDefinition {
    return this.#column("text", name);
  }

  integer(name: string): ColumnDefinition {
    return this.#column("integer", name);
  }

  unsignedInteger(name: string): ColumnDefinition {
    return this.#column("integer", name, { unsigned: true });
  }

  bigInteger(name: string): ColumnDefinition {
    return this.#column("bigInteger", name);
  }

  unsignedBigInteger(name: string): ColumnDefinition {
    return this.#column("bigInteger", name, { unsigned: true });
  }

  smallInteger(name: string): ColumnDefinition {
    return this.#column("smallInteger", name);
  }

  boolean(name: string): ColumnDefinition {
    return this.#column("boolean", name);
  }

  decimal(name: string, precision = 8, scale = 2): ColumnDefinition {
    return this.#column("decimal", name, { precision, scale });
  }

  float(name: string, precision = 53): ColumnDefinition {
    return this.#column("float", name, { precision });
  }

  double(name: string): ColumnDefinition {
    return this.#column("double", name);
  }

  date(name: string): ColumnDefinition {
    return this.#column("date", name);
  }

  /** `precision` is the number of fractional second digits; 0 (whole seconds) as in Laravel, 3 for milliseconds. */
  dateTime(name: string, precision = 0): ColumnDefinition {
    return this.#column("dateTime", name, { precision });
  }

  timestamp(name: string, precision = 0): ColumnDefinition {
    return this.#column("timestamp", name, { precision });
  }

  time(name: string, precision = 0): ColumnDefinition {
    return this.#column("time", name, { precision });
  }

  json(name: string): ColumnDefinition {
    return this.#column("json", name);
  }

  uuid(name = "uuid"): ColumnDefinition {
    return this.#column("uuid", name);
  }

  binary(name: string): ColumnDefinition {
    return this.#column("binary", name);
  }

  enum(name: string, values: readonly string[]): ColumnDefinition {
    if (!Array.isArray(values) || !values.length) throw new Error(`Tenora: enum("${name}") needs a list of values.`);
    return this.#column("enum", name, { values: [...values] });
  }

  /** An unsigned big integer for a foreign key; `.constrained()` adds the key. */
  foreignId(name: string): ForeignIdColumnDefinition {
    return this.#add(new ForeignIdColumnDefinition(this.#spec("bigInteger", name, { unsigned: true }), this));
  }

  /** Nullable `created_at` and `updated_at` timestamps. */
  timestamps(precision = 0): void {
    this.timestamp("created_at", precision).nullable();
    this.timestamp("updated_at", precision).nullable();
  }

  /** A nullable `deleted_at` timestamp, for soft deletes. */
  softDeletes(name = "deleted_at", precision = 0): ColumnDefinition {
    return this.timestamp(name, precision).nullable();
  }

  index(columns: string | readonly string[], name?: string): void {
    this.commands.push({ type: "index", columns: columnList(columns), name });
  }

  unique(columns: string | readonly string[], name?: string): void {
    this.commands.push({ type: "unique", columns: columnList(columns), name });
  }

  primary(columns: string | readonly string[], name?: string): void {
    this.commands.push({ type: "primary", columns: columnList(columns), name });
  }

  /** `t.foreign("team_id").references("id").on("teams").cascadeOnDelete()` */
  foreign(columns: string | readonly string[], name?: string): ForeignKeyDefinition {
    const key: ForeignKeySpec = { name, columns: columnList(columns), references: [] };
    this.commands.push({ type: "foreign", key });
    return new ForeignKeyDefinition(key);
  }

  dropColumn(...columns: string[] | [readonly string[]]): void {
    this.#alterOnly("dropColumn");
    const list = (Array.isArray(columns[0]) ? columns[0] : columns) as string[];
    this.commands.push({ type: "dropColumn", columns: [...list] });
  }

  renameColumn(from: string, to: string): void {
    this.#alterOnly("renameColumn");
    this.commands.push({ type: "renameColumn", from, to });
  }

  #drop(type: "dropIndex" | "dropUnique" | "dropForeign" | "dropPrimary", suffix: string, argument?: string | readonly string[]) {
    this.#alterOnly(type);
    if (argument === undefined) this.commands.push({ type });
    else if (typeof argument === "string") this.commands.push({ type, name: argument });
    else this.commands.push({ type, name: indexName(this.table, argument, suffix), columns: [...argument] });
  }

  /** By name, or by its columns: `dropIndex(["email"])` drops `users_email_index`. */
  dropIndex(nameOrColumns: string | readonly string[]): void {
    this.#drop("dropIndex", "index", nameOrColumns);
  }

  dropUnique(nameOrColumns: string | readonly string[]): void {
    this.#drop("dropUnique", "unique", nameOrColumns);
  }

  dropForeign(nameOrColumns: string | readonly string[]): void {
    this.#drop("dropForeign", "foreign", nameOrColumns);
  }

  /** The table's primary key, whatever its name. */
  dropPrimary(name?: string): void {
    this.#drop("dropPrimary", "primary", name);
  }

  /** Drops the foreign key on `column`, then the column. */
  dropConstrainedForeignId(column: string): void {
    this.dropForeign([column]);
    this.dropColumn(column);
  }

  dropTimestamps(): void {
    this.dropColumn("created_at", "updated_at");
  }

  dropSoftDeletes(name = "deleted_at"): void {
    this.dropColumn(name);
  }
}
