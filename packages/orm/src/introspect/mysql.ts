import type { Connection } from "../connection";
import { sql } from "../sql";
import {
  groupBy,
  referentialAction,
  sortChecks,
  sortForeignKeys,
  sortIndexes,
  splitType,
  truthy,
  typeSizes,
} from "./normalize";
import type { ColumnInfo, Introspector } from "./types";

// MySQL and MariaDB differ in what information_schema reports, and a MariaDB server reached through mysql2 without
// dialect: "mariadb" still answers the MariaDB way, so the server is asked rather than db.dialect.
const flavors = new WeakMap<Connection, Promise<boolean>>();
const isMariadb = (db: Connection) => {
  let flavor = flavors.get(db);
  if (!flavor) {
    flavor = db.raw<{ version: string }>(sql`select version() as version`).then((rows) => /mariadb/i.test(rows[0].version));
    flavor.catch(() => flavors.delete(db));
    flavors.set(db, flavor);
  }
  return flavor;
};

const NUMERIC_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "float",
  "double",
  "real",
  "bit",
  "year",
]);

/**
 * MySQL reports a literal default unquoted ('new' as new) and marks expressions with DEFAULT_GENERATED; MariaDB
 * quotes literals itself and reports "no default" as the text NULL. Both come out as MariaDB spells them.
 */
const normalizeDefault = (
  mariadb: boolean,
  value: string | null,
  dataType: string,
  extra: string
): string | null => {
  if (value === null) return null;
  if (mariadb) return value === "NULL" ? null : value;
  if (/DEFAULT_GENERATED/i.test(extra) || NUMERIC_TYPES.has(dataType)) return value;
  return `'${value.replace(/'/g, "''")}'`;
};

/** A name in another database is qualified with it. */
const qualified = (schema: string, table: string, current: string) =>
  schema === current ? table : `${schema}.${table}`;

export const mysql: Introspector = {
  async listTables(db) {
    const rows = await db.raw<{ name: string }>(
      sql`select table_name as name from information_schema.tables
        where table_schema = database() and table_type = 'BASE TABLE'`
    );
    return rows.map((row) => row.name);
  },

  async hasTable(db, table) {
    const rows = await db.raw(
      sql`select 1 as found from information_schema.tables
        where table_schema = database() and table_type = 'BASE TABLE' and table_name = ${table}`
    );
    return rows.length > 0;
  },

  async hasColumn(db, table, column) {
    const rows = await db.raw(
      sql`select 1 as found from information_schema.columns
        where table_schema = database() and table_name = ${table} and column_name = ${column}`
    );
    return rows.length > 0;
  },

  async describeTable(db, table) {
    const found = await db.raw<{ name: string; current: string }>(
      sql`select table_name as name, database() as ${sql.ref("current")} from information_schema.tables
        where table_schema = database() and table_type = 'BASE TABLE' and table_name = ${table}`
    );
    if (!found.length) return undefined;
    const { name, current } = found[0];
    const mariadb = await isMariadb(db);

    // MariaDB stores json as longtext with a json_valid() check named after the column.
    const jsonCheck = mariadb
      ? sql`exists (select 1 from information_schema.check_constraints cc
          where cc.constraint_schema = c.table_schema and cc.table_name = c.table_name
            and cc.constraint_name = c.column_name and cc.check_clause = concat('json_valid(\`', c.column_name, '\`)'))`
      : sql`0`;
    const columnRows = await db.raw<{
      name: string;
      raw_type: string;
      data_type: string;
      nullable: string;
      default_value: string | null;
      extra: string;
      is_json: unknown;
    }>(
      sql`select c.column_name as name, c.column_type as raw_type, c.data_type as data_type,
          c.is_nullable as nullable, c.column_default as default_value, c.extra as extra, ${jsonCheck} as is_json
        from information_schema.columns c
        where c.table_schema = database() and c.table_name = ${name}
        order by c.ordinal_position`
    );

    // A prefix index shows as email(191); MySQL 8 reports an expression's text in EXPRESSION, which MariaDB lacks.
    const expression = mariadb ? sql`null` : sql`expression`;
    const indexRows = await db.raw<{
      name: string;
      non_unique: unknown;
      column_name: string | null;
      sub_part: number | null;
      expression: string | null;
    }>(
      sql`select index_name as name, non_unique as non_unique, column_name as column_name, sub_part as sub_part,
          ${expression} as ${sql.ref("expression")}
        from information_schema.statistics
        where table_schema = database() and table_name = ${name}
        order by index_name, seq_in_index`
    );

    const foreignKeyRows = await db.raw<{
      name: string;
      column_name: string;
      referenced_schema: string;
      referenced_table: string;
      referenced_column: string;
      on_delete: string;
      on_update: string;
    }>(
      sql`select k.constraint_name as name, k.column_name as column_name, k.referenced_table_schema as referenced_schema,
          k.referenced_table_name as referenced_table, k.referenced_column_name as referenced_column,
          r.delete_rule as on_delete, r.update_rule as on_update
        from information_schema.key_column_usage k
        join information_schema.referential_constraints r
          on r.constraint_schema = k.constraint_schema and r.table_name = k.table_name and r.constraint_name = k.constraint_name
        where k.table_schema = database() and k.table_name = ${name} and k.referenced_table_name is not null
        order by k.constraint_name, k.ordinal_position`
    );

    // MariaDB's check_constraints has the table name, MySQL's only the constraint's; both are unique per database.
    // The json_valid() check MariaDB adds to a json column is the column's type, not a check.
    const checkRows = await db.raw<{ name: string; expression: string }>(
      mariadb
        ? sql`select constraint_name as name, check_clause as ${sql.ref("expression")}
            from information_schema.check_constraints
            where constraint_schema = database() and table_name = ${name}
              and check_clause <> concat('json_valid(\`', constraint_name, '\`)')`
        : sql`select cc.constraint_name as name, cc.check_clause as ${sql.ref("expression")}
            from information_schema.table_constraints tc
            join information_schema.check_constraints cc
              on cc.constraint_schema = tc.constraint_schema and cc.constraint_name = tc.constraint_name
            where tc.table_schema = database() and tc.table_name = ${name} and tc.constraint_type = 'CHECK'`
    );

    const indexGroups = groupBy(indexRows, (row) => row.name);
    const primaryKey = (indexGroups.get("PRIMARY") ?? []).map((row) => row.column_name ?? "");
    indexGroups.delete("PRIMARY");

    const columns = columnRows.map((row): ColumnInfo => {
      const type = truthy(row.is_json) ? "json" : row.data_type.toLowerCase();
      return {
        name: row.name,
        type,
        rawType: row.raw_type,
        ...typeSizes(row.data_type.toLowerCase(), splitType(row.raw_type).args),
        nullable: row.nullable === "YES",
        default: normalizeDefault(mariadb, row.default_value, row.data_type.toLowerCase(), row.extra ?? ""),
        autoIncrement: /auto_increment/i.test(row.extra ?? ""),
        primaryKey: primaryKey.includes(row.name),
      };
    });

    const indexes = [...indexGroups].map(([indexName, rows]) => ({
      name: indexName,
      columns: rows.map((row) =>
        row.column_name === null
          ? (row.expression ?? "")
          : row.sub_part === null
            ? row.column_name
            : `${row.column_name}(${row.sub_part})`
      ),
      unique: !truthy(rows[0].non_unique),
    }));

    const foreignKeys = [...groupBy(foreignKeyRows, (row) => row.name)].map(([keyName, rows]) => ({
      name: keyName,
      columns: rows.map((row) => row.column_name),
      referencedTable: qualified(rows[0].referenced_schema, rows[0].referenced_table, current),
      referencedColumns: rows.map((row) => row.referenced_column),
      onDelete: referentialAction(rows[0].on_delete),
      onUpdate: referentialAction(rows[0].on_update),
    }));

    return {
      name,
      columns,
      primaryKey,
      indexes: sortIndexes(indexes),
      foreignKeys: sortForeignKeys(foreignKeys),
      // MySQL escapes the quotes in a check's text: _utf8mb4\'new\' → _utf8mb4'new'.
      checks: sortChecks(
        checkRows.map((row) => ({ name: row.name, expression: mariadb ? row.expression : row.expression.replace(/\\'/g, "'") }))
      ),
    };
  },
};
