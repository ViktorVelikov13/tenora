/**
 * The other module that uses Kysely: it turns the schema builder's statements into SQL through Kysely's schema
 * builder in compile-only mode. The decisions (types, names, which statements a dialect needs) are made before, in
 * `schema/grammar.ts`; what reaches this module is already one statement for one dialect. Statements Kysely's builder
 * has no shape for (SQL Server's sp_rename and default constraints, MySQL's DROP FOREIGN KEY) are `sql` templates.
 *
 * DDL takes no bound parameters, so every value in a statement is written as a literal before it gets here.
 */
import {
  type ColumnDefinitionBuilder,
  type CreateTableBuilder,
  DummyDriver,
  type ForeignKeyConstraintBuilder,
  Kysely,
  MssqlAdapter,
  MssqlIntrospector,
  MssqlQueryCompiler,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type RawBuilder,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql as kysql,
} from "kysely";
import type { CompiledQuery } from "./compile";
import type { Dialect } from "./dialect";
import { RawSql, SqlIdentifier, SqlText } from "./sql";

export type ReferentialAction = "cascade" | "set null" | "restrict" | "no action" | "set default";

export type ForeignKeyDdl = {
  readonly name: string;
  readonly columns: readonly string[];
  readonly table: string;
  readonly references: readonly string[];
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
};

/** A column with its dialect's type and literal default already written. */
export type ColumnDdl = {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  /** a literal or expression: `'x'`, `0`, `CURRENT_TIMESTAMP`, or a `sql` fragment without bound values */
  readonly default?: string | RawSql;
  /** SQL Server: the name of the column's default constraint */
  readonly defaultName?: string;
  readonly unsigned?: boolean;
  readonly autoIncrement?: boolean;
  readonly primaryKey?: boolean;
  readonly check?: RawSql;
  /** a foreign key written into the column, for a column SQLite adds to an existing table */
  readonly references?: ForeignKeyDdl;
};

export type DdlStatement =
  | {
      readonly kind: "createTable";
      readonly table: string;
      readonly columns: readonly ColumnDdl[];
      readonly primaryKey?: { readonly name: string; readonly columns: readonly string[] };
      readonly foreignKeys: readonly ForeignKeyDdl[];
    }
  | { readonly kind: "addColumns"; readonly table: string; readonly columns: readonly ColumnDdl[] }
  | { readonly kind: "changeColumn"; readonly table: string; readonly column: ColumnDdl }
  | { readonly kind: "dropColumns"; readonly table: string; readonly columns: readonly string[] }
  | { readonly kind: "renameColumn"; readonly table: string; readonly from: string; readonly to: string }
  | { readonly kind: "createIndex"; readonly table: string; readonly name: string; readonly columns: readonly string[]; readonly unique: boolean }
  | { readonly kind: "addUnique"; readonly table: string; readonly name: string; readonly columns: readonly string[] }
  | { readonly kind: "addPrimary"; readonly table: string; readonly name: string; readonly columns: readonly string[] }
  | { readonly kind: "addForeign"; readonly table: string; readonly key: ForeignKeyDdl }
  | { readonly kind: "dropConstraint"; readonly table: string; readonly name: string }
  | { readonly kind: "dropIndex"; readonly table: string; readonly name: string }
  | { readonly kind: "dropForeign"; readonly table: string; readonly name: string }
  | { readonly kind: "dropPrimary"; readonly table: string; readonly name?: string }
  /** SQL Server: drops the default constraints of these columns, whatever they are called */
  | { readonly kind: "dropDefaults"; readonly table: string; readonly columns: readonly string[] }
  | { readonly kind: "addDefault"; readonly table: string; readonly column: ColumnDdl }
  | { readonly kind: "dropTable"; readonly table: string; readonly ifExists: boolean }
  | { readonly kind: "renameTable"; readonly from: string; readonly to: string };

const createCold = (dialect: Dialect): Kysely<any> => {
  const parts =
    dialect === "postgres"
      ? ([PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler] as const)
      : dialect === "sqlite"
        ? ([SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler] as const)
        : dialect === "mssql"
          ? ([MssqlAdapter, MssqlIntrospector, MssqlQueryCompiler] as const)
          : ([MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler] as const);
  const [Adapter, Introspector, Compiler] = parts;
  return new Kysely<any>({
    dialect: {
      createAdapter: () => new Adapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new Introspector(db),
      createQueryCompiler: () => new Compiler(),
    },
  });
};

const cold = new Map<Dialect, Kysely<any>>();
const coldFor = (dialect: Dialect) => {
  let instance = cold.get(dialect);
  if (!instance) {
    instance = createCold(dialect);
    cold.set(dialect, instance);
  }
  return instance;
};

const toKysely = (raw: RawSql): RawBuilder<unknown> =>
  kysql(
    raw.strings as unknown as TemplateStringsArray,
    ...raw.values.map((value) =>
      value instanceof SqlIdentifier
        ? kysql.ref(value.name)
        : value instanceof SqlText
          ? kysql.raw(value.text)
          : value instanceof RawSql
            ? toKysely(value)
            : value
    )
  );

/** A string literal for the dialect. */
export const literal = (dialect: Dialect, value: string): string => {
  const quoted = value.replace(/'/g, "''");
  if (dialect === "mysql" || dialect === "mariadb") return `'${quoted.replace(/\\/g, "\\\\")}'`;
  if (dialect === "mssql") return `N'${quoted}'`;
  return `'${quoted}'`;
};

const expression = (value: string | RawSql) => (typeof value === "string" ? kysql.raw(value) : toKysely(value));

const ACTIONS: Record<ReferentialAction, ReferentialAction> = {
  cascade: "cascade",
  "set null": "set null",
  restrict: "restrict",
  "no action": "no action",
  "set default": "set default",
};

/** SQL Server has no RESTRICT; NO ACTION is what it means there. */
const action = (dialect: Dialect, value: ReferentialAction) =>
  dialect === "mssql" && value === "restrict" ? "no action" : ACTIONS[value];

const foreignActions = (dialect: Dialect, key: ForeignKeyDdl) => (builder: ForeignKeyConstraintBuilder) => {
  let built = builder;
  if (key.onDelete) built = built.onDelete(action(dialect, key.onDelete));
  if (key.onUpdate) built = built.onUpdate(action(dialect, key.onUpdate));
  return built;
};

const referencesClause = (dialect: Dialect, key: ForeignKeyDdl) =>
  kysql`constraint ${kysql.id(key.name)} references ${kysql.table(key.table)} (${kysql.join(
    key.references.map((column) => kysql.id(column))
  )})${key.onDelete ? kysql.raw(` on delete ${action(dialect, key.onDelete)}`) : kysql``}${
    key.onUpdate ? kysql.raw(` on update ${action(dialect, key.onUpdate)}`) : kysql``
  }`;

const column = (dialect: Dialect, ddl: ColumnDdl) => (builder: ColumnDefinitionBuilder) => {
  let col = builder;
  if (ddl.unsigned) col = col.unsigned();
  if (ddl.defaultName && ddl.default !== undefined) col = col.modifyFront(kysql`constraint ${kysql.id(ddl.defaultName)}`);
  if (ddl.autoIncrement && dialect === "mssql") col = col.identity();
  if (ddl.default !== undefined) col = col.defaultTo(expression(ddl.default));
  col = ddl.nullable ? col.modifyEnd(kysql`null`) : col.notNull();
  if (ddl.primaryKey) col = col.primaryKey();
  // Postgres auto-increments through its serial types, SQL Server through identity.
  if (ddl.autoIncrement && (dialect === "mysql" || dialect === "mariadb" || dialect === "sqlite")) col = col.autoIncrement();
  if (ddl.check) col = col.check(toKysely(ddl.check));
  if (ddl.references) col = col.modifyEnd(referencesClause(dialect, ddl.references));
  return col;
};

const dataType = (ddl: ColumnDdl) => kysql.raw(ddl.type);

/** SQL Server: drop the default constraints on these columns, whatever their names. */
const dropDefaults = (dialect: Dialect, table: string, columns: readonly string[]) => {
  const names = columns.map((name) => literal(dialect, name)).join(", ");
  return kysql.raw(
    `declare @sql nvarchar(max) = N''; select @sql += N'alter table ' + quotename(object_schema_name(c.object_id)) + N'.' + quotename(object_name(c.object_id)) + N' drop constraint ' + quotename(d.name) + N';' from sys.columns as c join sys.default_constraints as d on d.object_id = c.default_object_id where c.object_id = object_id(${literal(dialect, table)}) and c.name in (${names}); exec sp_executesql @sql`
  );
};

const plain = ({ sql, parameters }: CompiledQuery): CompiledQuery => ({ sql, parameters });

export const compileSchema = (dialect: Dialect, statement: DdlStatement): CompiledQuery => {
  const db = coldFor(dialect);
  const schema = db.schema;
  const isMysql = dialect === "mysql" || dialect === "mariadb";
  switch (statement.kind) {
    case "createTable": {
      // Kysely types a new table's columns from addColumn() calls; these are only known at runtime.
      let create = schema.createTable(statement.table) as CreateTableBuilder<string, string>;
      for (const ddl of statement.columns) create = create.addColumn(ddl.name, dataType(ddl), column(dialect, ddl));
      if (statement.primaryKey) {
        create = create.addPrimaryKeyConstraint(statement.primaryKey.name, [...statement.primaryKey.columns]);
      }
      for (const key of statement.foreignKeys) {
        create = create.addForeignKeyConstraint(key.name, [...key.columns], key.table, [...key.references], foreignActions(dialect, key));
      }
      return plain(create.compile());
    }
    case "addColumns": {
      const [first, ...rest] = statement.columns;
      let alter = schema.alterTable(statement.table).addColumn(first.name, dataType(first), column(dialect, first));
      for (const ddl of rest) alter = alter.addColumn(ddl.name, dataType(ddl), column(dialect, ddl));
      return plain(alter.compile());
    }
    case "changeColumn": {
      const { table, column: ddl } = statement;
      if (isMysql) {
        return plain(schema.alterTable(table).modifyColumn(ddl.name, dataType(ddl), column(dialect, ddl)).compile());
      }
      if (dialect === "mssql") {
        return plain(
          kysql`alter table ${kysql.table(table)} alter column ${kysql.id(ddl.name)} ${kysql.raw(ddl.type)}${kysql.raw(
            ddl.nullable ? " null" : " not null"
          )}`.compile(db)
        );
      }
      // Postgres: type, nullability and default, in one statement.
      const type = kysql`${kysql.raw(ddl.type)} using ${kysql.ref(ddl.name)}::${kysql.raw(ddl.type)}`;
      let alter = schema
        .alterTable(table)
        .alterColumn(ddl.name, (col) => col.setDataType(type))
        .alterColumn(ddl.name, (col) => (ddl.nullable ? col.dropNotNull() : col.setNotNull()));
      alter =
        ddl.default === undefined
          ? alter.alterColumn(ddl.name, (col) => col.dropDefault())
          : alter.alterColumn(ddl.name, (col) => col.setDefault(expression(ddl.default!)));
      return plain(alter.compile());
    }
    case "dropColumns": {
      const [first, ...rest] = statement.columns;
      let alter = schema.alterTable(statement.table).dropColumn(first);
      for (const name of rest) alter = alter.dropColumn(name);
      return plain(alter.compile());
    }
    case "renameColumn":
      if (dialect === "mssql") {
        return plain(
          kysql
            .raw(`exec sp_rename ${literal(dialect, `${statement.table}.${statement.from}`)}, ${literal(dialect, statement.to)}, N'COLUMN'`)
            .compile(db)
        );
      }
      return plain(schema.alterTable(statement.table).renameColumn(statement.from, statement.to).compile());
    case "createIndex": {
      const index = schema.createIndex(statement.name).on(statement.table).columns([...statement.columns]);
      return plain((statement.unique ? index.unique() : index).compile());
    }
    case "addUnique":
      return plain(schema.alterTable(statement.table).addUniqueConstraint(statement.name, [...statement.columns]).compile());
    case "addPrimary":
      return plain(schema.alterTable(statement.table).addPrimaryKeyConstraint(statement.name, [...statement.columns]).compile());
    case "addForeign": {
      const { key } = statement;
      return plain(
        schema
          .alterTable(statement.table)
          .addForeignKeyConstraint(key.name, [...key.columns], key.table, [...key.references], foreignActions(dialect, key))
          .compile()
      );
    }
    case "dropConstraint":
      return plain(schema.alterTable(statement.table).dropConstraint(statement.name).compile());
    case "dropIndex": {
      const drop = schema.dropIndex(statement.name);
      // MySQL and SQL Server name indexes per table.
      return plain((isMysql || dialect === "mssql" ? drop.on(statement.table) : drop).compile());
    }
    case "dropForeign":
      if (isMysql) {
        return plain(kysql`alter table ${kysql.table(statement.table)} drop foreign key ${kysql.id(statement.name)}`.compile(db));
      }
      return plain(schema.alterTable(statement.table).dropConstraint(statement.name).compile());
    case "dropPrimary":
      if (isMysql) return plain(kysql`alter table ${kysql.table(statement.table)} drop primary key`.compile(db));
      if (dialect === "mssql" && !statement.name) {
        // An id() key gets a name SQL Server makes up, so look it up.
        return plain(
          kysql
            .raw(
              `declare @sql nvarchar(max) = (select N'alter table ' + quotename(object_schema_name(parent_object_id)) + N'.' + quotename(object_name(parent_object_id)) + N' drop constraint ' + quotename(name) from sys.key_constraints where type = 'PK' and parent_object_id = object_id(${literal(dialect, statement.table)})); if @sql is not null exec sp_executesql @sql`
            )
            .compile(db)
        );
      }
      return plain(
        schema
          .alterTable(statement.table)
          .dropConstraint(statement.name ?? `${statement.table}_pkey`)
          .compile()
      );
    case "dropDefaults":
      return plain(dropDefaults(dialect, statement.table, statement.columns).compile(db));
    case "addDefault": {
      const ddl = statement.column;
      return plain(
        kysql`alter table ${kysql.table(statement.table)} add constraint ${kysql.id(ddl.defaultName!)} default ${expression(
          ddl.default!
        )} for ${kysql.id(ddl.name)}`.compile(db)
      );
    }
    case "dropTable": {
      const drop = schema.dropTable(statement.table);
      return plain((statement.ifExists ? drop.ifExists() : drop).compile());
    }
    case "renameTable":
      if (dialect === "mssql") {
        return plain(
          kysql.raw(`exec sp_rename ${literal(dialect, statement.from)}, ${literal(dialect, statement.to)}`).compile(db)
        );
      }
      return plain(schema.alterTable(statement.from).renameTo(statement.to).compile());
  }
};

/** A `sql` fragment compiled for the dialect, for DDL text that is assembled outside Kysely (SQLite rebuilds). */
export const compileFragment = (dialect: Dialect, fragment: RawSql): string => {
  const compiled = toKysely(fragment).compile(coldFor(dialect));
  if (compiled.parameters.length) throw new Error("Tenora: DDL cannot take bound values; write them as literals.");
  return compiled.sql;
};
