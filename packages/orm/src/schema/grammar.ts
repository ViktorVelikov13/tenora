/**
 * Turns a Laravel-style blueprint into the statements each database needs: the column types, the names of keys and
 * indexes, and which changes SQLite has to make by rebuilding the table. `compileSchema.ts` writes the SQL.
 */
import {
  type ColumnDdl,
  compileFragment,
  compileSchema,
  type DdlStatement,
  type ForeignKeyDdl,
  literal,
  type TableOptions,
} from "../compileSchema";
import type { Dialect } from "../dialect";
import { RawSql, SqlIdentifier, SqlText, sql } from "../sql";
import {
  type Blueprint,
  type ColumnSpec,
  type Command,
  type ForeignKeySpec,
  type IndexCommand,
  indexName,
  type PrimaryCommand,
} from "./blueprint";
import type { SchemaRunner, SchemaStep } from "./runner";
import {
  type Clause,
  type ColumnDefinition,
  columnDependencies,
  hasName,
  quoteIdentifier,
  rebuildTable,
  sameName,
  type TableDefinition,
  writeColumn,
} from "./sqlite";

const isMysql = (dialect: Dialect) => dialect === "mysql" || dialect === "mariadb";

const columnType = (dialect: Dialect, spec: ColumnSpec): string => {
  const mysql = isMysql(dialect);
  const precision = spec.precision ?? 0;
  switch (spec.type) {
    case "increments":
      if (dialect === "postgres") return spec.change ? "integer" : "serial";
      return dialect === "sqlite" ? "integer" : "int";
    case "bigIncrements":
      if (dialect === "postgres") return spec.change ? "bigint" : "bigserial";
      return dialect === "sqlite" ? "integer" : "bigint";
    case "string":
      if (dialect === "sqlite") return "varchar";
      return `${dialect === "mssql" ? "nvarchar" : "varchar"}(${spec.length ?? 255})`;
    case "text":
      return dialect === "mssql" ? "nvarchar(max)" : "text";
    case "integer":
      return mysql || dialect === "mssql" ? "int" : "integer";
    case "bigInteger":
      return dialect === "sqlite" ? "integer" : "bigint";
    case "smallInteger":
      return dialect === "sqlite" ? "integer" : "smallint";
    case "boolean":
      return dialect === "postgres" ? "boolean" : dialect === "mssql" ? "bit" : "tinyint(1)";
    case "decimal":
      return dialect === "sqlite" ? "numeric" : `decimal(${spec.precision ?? 8}, ${spec.scale ?? 2})`;
    case "float":
      return dialect === "sqlite" ? "float" : `float(${spec.precision ?? 53})`;
    case "double":
      return mysql || dialect === "sqlite" ? "double" : "double precision";
    case "date":
      return "date";
    case "dateTime":
    case "timestamp":
      if (dialect === "postgres") return `timestamp(${precision}) without time zone`;
      if (dialect === "mssql") return `datetime2(${precision})`;
      if (mysql) {
        const type = spec.type === "dateTime" ? "datetime" : "timestamp";
        return precision ? `${type}(${precision})` : type;
      }
      return "datetime";
    case "time":
      if (dialect === "postgres") return `time(${precision}) without time zone`;
      if (dialect === "mssql") return `time(${precision})`;
      if (mysql) return precision ? `time(${precision})` : "time";
      return "time";
    case "json":
      if (dialect === "mssql") return "nvarchar(max)";
      return dialect === "sqlite" ? "text" : "json";
    case "uuid":
      if (dialect === "postgres") return "uuid";
      if (dialect === "mssql") return "uniqueidentifier";
      return mysql ? "char(36)" : "varchar";
    case "binary":
      if (dialect === "postgres") return "bytea";
      return dialect === "mssql" ? "varbinary(max)" : "blob";
    case "enum":
      if (mysql) return `enum(${spec.values!.map((value) => literal(dialect, value)).join(", ")})`;
      if (dialect === "sqlite") return "varchar";
      return dialect === "mssql" ? "nvarchar(255)" : "varchar(255)";
  }
};

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** A `sql` fragment with its values written as literals, since DDL takes no bound parameters. */
const inline = (dialect: Dialect, raw: RawSql): RawSql =>
  new RawSql(
    raw.strings,
    raw.values.map((value) =>
      value instanceof SqlIdentifier || value instanceof SqlText
        ? value
        : value instanceof RawSql
          ? inline(dialect, value)
          : new SqlText(valueLiteral(dialect, value))
    )
  );

const valueLiteral = (dialect: Dialect, value: unknown): string => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return dialect === "postgres" ? String(value) : value ? "1" : "0";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Date) {
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}.${pad(value.getUTCMilliseconds(), 3)}`;
    return literal(dialect, date);
  }
  return literal(dialect, typeof value === "string" ? value : JSON.stringify(value));
};

const columnDefault = (dialect: Dialect, spec: ColumnSpec): string | RawSql | undefined => {
  if (spec.useCurrent) return "CURRENT_TIMESTAMP";
  if (!spec.default) return undefined;
  const { value } = spec.default;
  if (value instanceof RawSql) return inline(dialect, value);
  const written = valueLiteral(dialect, value);
  // MySQL takes a literal default for TEXT, BLOB and JSON only as an expression.
  return isMysql(dialect) && typeof value === "string" && ["text", "json", "binary"].includes(spec.type)
    ? `(${written})`
    : written;
};

const columnDdl = (dialect: Dialect, table: string, spec: ColumnSpec): ColumnDdl => {
  const defaultValue = columnDefault(dialect, spec);
  const changing = spec.change;
  return {
    name: spec.name,
    type: columnType(dialect, spec),
    nullable: spec.nullable && !spec.autoIncrement,
    default: defaultValue,
    defaultName: dialect === "mssql" && defaultValue !== undefined ? indexName(table, [spec.name], "default") : undefined,
    unsigned: isMysql(dialect) && spec.unsigned,
    // A changed column keeps its primary key; MySQL's MODIFY has to repeat AUTO_INCREMENT, the others cannot.
    autoIncrement: spec.autoIncrement && (!changing || isMysql(dialect)),
    primaryKey: spec.autoIncrement && !changing,
    check:
      spec.type === "enum" && !isMysql(dialect)
        ? sql`${sql.ref(spec.name)} in (${sql.raw(spec.values!.map((value) => literal(dialect, value)).join(", "))})`
        : undefined,
  };
};

const foreignDdl = (table: string, key: ForeignKeySpec): ForeignKeyDdl => {
  if (!key.on) throw new Error(`Tenora: the foreign key on ${table}(${key.columns.join(", ")}) needs on(table).`);
  if (!key.references.length) {
    throw new Error(`Tenora: the foreign key on ${table}(${key.columns.join(", ")}) needs references(column).`);
  }
  return {
    name: key.name ?? indexName(table, key.columns, "foreign"),
    columns: key.columns,
    table: key.on,
    references: key.references,
    onDelete: key.onDelete,
    onUpdate: key.onUpdate,
  };
};

/** Postgres's own name for a primary key, which dropPrimary() relies on; Laravel's name elsewhere. */
const primaryName = (dialect: Dialect, table: string, command: PrimaryCommand) =>
  command.name ?? (dialect === "postgres" ? `${table}_pkey` : indexName(table, command.columns, "primary"));

const statement = (dialect: Dialect, ddl: DdlStatement): SchemaStep => ({ kind: "sql", compiled: compileSchema(dialect, ddl) });

const runStep = (description: string, run: (runner: SchemaRunner) => Promise<void>): SchemaStep => ({
  kind: "run",
  description,
  run,
});

/** Index modifiers on columns (`.unique()`, `.index()`, `.primary()`) become commands after the explicit ones. */
const fluentIndexes = (blueprint: Blueprint): Command[] =>
  blueprint.columns.flatMap(({ spec }): Command[] => [
    ...(spec.primary ? [{ type: "primary", columns: [spec.name] } as const] : []),
    ...(spec.unique ? [{ type: "unique", columns: [spec.name], name: spec.unique === true ? undefined : spec.unique } as const] : []),
    ...(spec.index ? [{ type: "index", columns: [spec.name], name: spec.index === true ? undefined : spec.index } as const] : []),
  ]);

const indexStep = (dialect: Dialect, table: string, command: IndexCommand) => {
  const name = command.name ?? indexName(table, command.columns, command.type);
  // Postgres and MySQL get a unique constraint; SQLite and SQL Server a unique index, which their dropUnique() drops.
  if (command.type === "unique" && (dialect === "postgres" || isMysql(dialect))) {
    return statement(dialect, { kind: "addUnique", table, name, columns: command.columns });
  }
  return statement(dialect, { kind: "createIndex", table, name, columns: command.columns, unique: command.type === "unique" });
};

export const compileCreate = (dialect: Dialect, blueprint: Blueprint, options?: TableOptions): SchemaStep[] => {
  const { table } = blueprint;
  if (blueprint.columns.some(({ spec }) => spec.change)) {
    throw new Error("Tenora: change() only works in schema.table(), not in schema.create().");
  }
  if (!blueprint.columns.length) throw new Error(`Tenora: table "${table}" needs at least one column.`);
  const commands = [...blueprint.commands, ...fluentIndexes(blueprint)];
  const primaries = commands.filter((command): command is PrimaryCommand => command.type === "primary");
  const increments = blueprint.columns.filter(({ spec }) => spec.autoIncrement);
  if (primaries.length > 1) throw new Error(`Tenora: table "${table}" can have only one primary key.`);
  if (increments.length > 1) throw new Error(`Tenora: table "${table}" can have only one auto-increment column.`);
  if (primaries.length && increments.length) {
    throw new Error(
      `Tenora: table "${table}" has an auto-increment primary key ("${increments[0].spec.name}") already; it cannot have primary() too.`
    );
  }
  const [primary] = primaries;
  const steps: SchemaStep[] = [
    statement(dialect, {
      kind: "createTable",
      table,
      columns: blueprint.columns.map(({ spec }) => columnDdl(dialect, table, spec)),
      primaryKey: primary && { name: primaryName(dialect, table, primary), columns: primary.columns },
      foreignKeys: commands.flatMap((command) => (command.type === "foreign" ? [foreignDdl(table, command.key)] : [])),
      options,
    }),
  ];
  for (const command of commands) {
    if (command.type === "index" || command.type === "unique") steps.push(indexStep(dialect, table, command));
  }
  return steps;
};

export const compileAlter = (dialect: Dialect, blueprint: Blueprint): SchemaStep[] => {
  const { table } = blueprint;
  const added = blueprint.columns.filter(({ spec }) => !spec.change).map(({ spec }) => spec);
  const changed = blueprint.columns.filter(({ spec }) => spec.change).map(({ spec }) => spec);
  const commands = [...blueprint.commands, ...fluentIndexes(blueprint)];
  const steps: SchemaStep[] = [];
  const written = new Set<Command>();

  if (added.length && dialect === "sqlite") {
    // SQLite adds one column per statement; a foreign key on a new column is written into it, which needs no rebuild.
    for (const spec of added) {
      const key = commands.find(
        (command): command is Extract<Command, { type: "foreign" }> =>
          command.type === "foreign" && !written.has(command) && command.key.columns.length === 1 && sameName(command.key.columns[0], spec.name)
      );
      if (key) written.add(key);
      const ddl = { ...columnDdl(dialect, table, spec), references: key && foreignDdl(table, key.key) };
      steps.push(statement(dialect, { kind: "addColumns", table, columns: [ddl] }));
    }
  } else if (added.length) {
    steps.push(statement(dialect, { kind: "addColumns", table, columns: added.map((spec) => columnDdl(dialect, table, spec)) }));
  }

  if (changed.length && dialect === "sqlite") {
    const changes = changed.map((spec) => columnDdl(dialect, table, spec));
    steps.push(
      rebuildStep(table, `change ${changes.map((change) => `"${change.name}"`).join(", ")}`, (definition) =>
        changeColumns(definition, changes)
      )
    );
  } else {
    for (const spec of changed) {
      const ddl = columnDdl(dialect, table, spec);
      if (dialect === "mssql") {
        steps.push(statement(dialect, { kind: "dropDefaults", table, columns: [ddl.name] }));
        steps.push(statement(dialect, { kind: "changeColumn", table, column: ddl }));
        if (ddl.default !== undefined) steps.push(statement(dialect, { kind: "addDefault", table, column: ddl }));
      } else {
        steps.push(statement(dialect, { kind: "changeColumn", table, column: ddl }));
      }
    }
  }

  for (const command of commands) {
    if (written.has(command)) continue;
    steps.push(...commandSteps(dialect, table, command));
  }
  return steps;
};

const commandSteps = (dialect: Dialect, table: string, command: Command): SchemaStep[] => {
  const sqlite = dialect === "sqlite";
  switch (command.type) {
    case "index":
    case "unique":
      return [indexStep(dialect, table, command)];
    case "primary": {
      const name = primaryName(dialect, table, command);
      if (sqlite) {
        return [rebuildStep(table, `primary key (${command.columns.join(", ")})`, (definition) => setPrimaryKey(definition, command.columns, name))];
      }
      return [statement(dialect, { kind: "addPrimary", table, name, columns: command.columns })];
    }
    case "foreign": {
      const key = foreignDdl(table, command.key);
      if (sqlite) return [rebuildStep(table, `add foreign key "${key.name}"`, (definition) => addForeignKey(definition, key))];
      return [statement(dialect, { kind: "addForeign", table, key })];
    }
    case "dropColumn":
      if (sqlite) return [dropSqliteColumns(table, command.columns)];
      if (dialect === "mssql") {
        return [
          statement(dialect, { kind: "dropDefaults", table, columns: command.columns }),
          statement(dialect, { kind: "dropColumns", table, columns: command.columns }),
        ];
      }
      return [statement(dialect, { kind: "dropColumns", table, columns: command.columns })];
    case "renameColumn":
      return [statement(dialect, { kind: "renameColumn", table, from: command.from, to: command.to })];
    case "dropIndex":
      return [statement(dialect, { kind: "dropIndex", table, name: requiredName(command) })];
    case "dropUnique": {
      const name = requiredName(command);
      if (dialect === "postgres") return [statement(dialect, { kind: "dropConstraint", table, name })];
      return [statement(dialect, { kind: "dropIndex", table, name })];
    }
    case "dropForeign": {
      const name = requiredName(command);
      if (sqlite) {
        return [rebuildStep(table, `drop foreign key "${name}"`, (definition) => dropForeignKey(definition, table, name, command.columns))];
      }
      return [statement(dialect, { kind: "dropForeign", table, name })];
    }
    case "dropPrimary":
      if (sqlite) return [rebuildStep(table, "drop primary key", dropPrimaryKey)];
      return [statement(dialect, { kind: "dropPrimary", table, name: command.name })];
  }
};

const requiredName = (command: { type: string; name?: string }) => {
  if (!command.name) throw new Error(`Tenora: ${command.type}() needs a name or a list of columns.`);
  return command.name;
};

/** SQLite drops an unconstrained column in place; a column in a key or an index needs a rebuild. */
const dropSqliteColumns = (table: string, columns: readonly string[]): SchemaStep =>
  runStep(`-- drop ${columns.map((column) => `"${column}"`).join(", ")} from "${table}" (rebuilds the table if a key or index uses them)`, async (runner) => {
    let rebuild = false;
    for (const column of columns) {
      const uses = await columnDependencies(runner, table, column);
      rebuild ||= uses.primary || uses.indexed || uses.foreign;
    }
    if (rebuild) {
      await rebuildTable(runner, table, (definition) => dropColumns(definition, table, columns), {
        dropped: columns,
        indexes: "drop",
        keepTriggers: true,
      });
      return;
    }
    for (const column of columns) await runner.execute(compileSchema("sqlite", { kind: "dropColumns", table, columns: [column] }));
  });

const rebuildStep = (table: string, change: string, alter: (definition: TableDefinition) => TableDefinition): SchemaStep =>
  runStep(`-- rebuild "${table}": ${change} (SQLite cannot alter it in place)`, (runner) =>
    rebuildTable(runner, table, alter, { indexes: "drop", keepTriggers: true })
  );

// What each change does to a SQLite table definition.

const KEPT_ON_CHANGE: readonly Clause["kind"][] = ["primary", "unique", "collate", "references", "generated", "other"];

/** change(): the new type, nullability, default and CHECK; the column's keys and collation stay. */
const changeColumns = (definition: TableDefinition, changes: readonly ColumnDdl[]): TableDefinition => {
  for (const change of changes) {
    if (!definition.columns.some((column) => sameName(column.name, change.name))) {
      throw new Error(`Tenora: SQLite table has no column "${change.name}" to change.`);
    }
  }
  return {
    ...definition,
    columns: definition.columns.map((column): ColumnDefinition => {
      const change = changes.find((candidate) => sameName(candidate.name, column.name));
      if (!change) return column;
      const clauses: Clause[] = [
        ...column.clauses.filter((clause) => KEPT_ON_CHANGE.includes(clause.kind)),
        change.nullable ? { kind: "null", text: "NULL" } : { kind: "notnull", text: "NOT NULL" },
        ...(change.default !== undefined
          ? [{ kind: "default", text: `DEFAULT ${typeof change.default === "string" ? change.default : compileFragment("sqlite", change.default)}` } as const]
          : []),
        ...(change.check ? [{ kind: "check", text: `CHECK (${compileFragment("sqlite", change.check)})` } as const] : []),
      ];
      return { ...column, type: change.type, clauses, text: writeColumn(column.nameText, change.type, clauses) };
    }),
  };
};

/** dropColumn(): the columns go, with the keys that use them; indexes on them are dropped after the rebuild. */
const dropColumns = (definition: TableDefinition, table: string, columns: readonly string[]): TableDefinition => ({
  ...definition,
  columns: definition.columns.filter((column) => !hasName(columns, column.name)),
  constraints: definition.constraints.filter(
    (constraint) =>
      !constraint.columns.some((column) => hasName(columns, column)) &&
      // a key of the table on itself that points at a dropped column
      !(sameName(constraint.references?.table, table) && constraint.references!.columns.some((column) => hasName(columns, column)))
  ),
});

const addForeignKey = (definition: TableDefinition, key: ForeignKeyDdl): TableDefinition => ({
  ...definition,
  constraints: [
    ...definition.constraints,
    {
      kind: "foreign",
      name: key.name,
      columns: [...key.columns],
      references: { table: key.table, columns: [...key.references] },
      text: [
        `CONSTRAINT ${quoteIdentifier(key.name)} FOREIGN KEY (${key.columns.map(quoteIdentifier).join(", ")})`,
        `REFERENCES ${quoteIdentifier(key.table)} (${key.references.map(quoteIdentifier).join(", ")})`,
        ...(key.onDelete ? [`ON DELETE ${key.onDelete.toUpperCase()}`] : []),
        ...(key.onUpdate ? [`ON UPDATE ${key.onUpdate.toUpperCase()}`] : []),
      ].join(" "),
    },
  ],
});

/**
 * dropForeign(): the key with that name, as a table constraint or inside a column. A key without a name (one Knex
 * or another tool wrote) is found by its columns when dropForeign() was given columns.
 */
const dropForeignKey = (definition: TableDefinition, table: string, name: string, columns?: readonly string[]): TableDefinition => {
  const byName = (candidate?: string) => sameName(candidate, name);
  const named =
    definition.constraints.some((constraint) => constraint.kind === "foreign" && byName(constraint.name)) ||
    definition.columns.some((column) => column.clauses.some((clause) => clause.kind === "references" && byName(clause.name)));
  const matches = (keyName: string | undefined, keyColumns: readonly (string | undefined)[]) =>
    named
      ? byName(keyName)
      : columns !== undefined &&
        keyColumns.length === columns.length &&
        keyColumns.every((column, index) => sameName(column, columns[index]));
  let dropped = 0;
  const constraints = definition.constraints.filter((constraint) => {
    const drop = constraint.kind === "foreign" && matches(constraint.name, constraint.columns);
    if (drop) dropped++;
    return !drop;
  });
  const newColumns = definition.columns.map((column) => {
    const clauses = column.clauses.filter((clause) => {
      const drop = clause.kind === "references" && matches(clause.name, [column.name]);
      if (drop) dropped++;
      return !drop;
    });
    return clauses.length === column.clauses.length
      ? column
      : { ...column, clauses, text: writeColumn(column.nameText, column.type, clauses) };
  });
  if (!dropped) throw new Error(`Tenora: SQLite table "${table}" has no foreign key "${name}".`);
  return { ...definition, columns: newColumns, constraints };
};

const withoutPrimaryKey = (definition: TableDefinition): TableDefinition => ({
  ...definition,
  columns: definition.columns.map((column) => {
    const clauses = column.clauses.filter((clause) => clause.kind !== "primary");
    return clauses.length === column.clauses.length
      ? column
      : { ...column, clauses, text: writeColumn(column.nameText, column.type, clauses) };
  }),
  constraints: definition.constraints.filter((constraint) => constraint.kind !== "primary"),
});

const setPrimaryKey = (definition: TableDefinition, columns: readonly string[], name: string): TableDefinition => {
  const without = withoutPrimaryKey(definition);
  return {
    ...without,
    constraints: [
      ...without.constraints,
      {
        kind: "primary",
        name,
        columns: [...columns],
        text: `CONSTRAINT ${quoteIdentifier(name)} PRIMARY KEY (${columns.map(quoteIdentifier).join(", ")})`,
      },
    ],
  };
};

const dropPrimaryKey = (definition: TableDefinition): TableDefinition => withoutPrimaryKey(definition);

export const compileBlueprint = (dialect: Dialect, blueprint: Blueprint, options?: TableOptions): SchemaStep[] =>
  blueprint.creating ? compileCreate(dialect, blueprint, options) : compileAlter(dialect, blueprint);
