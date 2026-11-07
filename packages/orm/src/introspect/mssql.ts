import { sql } from "../sql";
import { groupBy, referentialAction, sortChecks, sortForeignKeys, sortIndexes, truthy, typeSizes } from "./normalize";
import type { CheckInfo, ColumnInfo, ForeignKeyInfo, IndexInfo, Introspector } from "./types";

const inTable = (table: string) => sql`t.schema_id = schema_id() and t.name = ${table}`;

/** sys.columns counts lengths in bytes, -1 meaning max; nchar and nvarchar take two bytes a character. */
const rawTypeOf = (type: string, maxLength: number, precision: number, scale: number) => {
  switch (type) {
    case "char":
    case "varchar":
    case "binary":
    case "varbinary":
      return `${type}(${maxLength === -1 ? "max" : maxLength})`;
    case "nchar":
    case "nvarchar":
      return `${type}(${maxLength === -1 ? "max" : maxLength / 2})`;
    case "decimal":
    case "numeric":
      return `${type}(${precision},${scale})`;
    case "datetime2":
    case "datetimeoffset":
    case "time":
      return `${type}(${scale})`;
    default:
      return type;
  }
};

/** SQL Server wraps defaults in parentheses, numbers twice: ((0)) → 0, ('new') → 'new', (getdate()) → getdate(). */
const unwrap = (value: string): string => {
  let text = value.trim();
  while (text.startsWith("(") && text.endsWith(")")) {
    // Only when the first parenthesis closes at the very end: (a) + (b) is not wrapped.
    let depth = 0;
    let quoted = false;
    let wraps = true;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'") quoted = !quoted;
      if (quoted) continue;
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (depth === 0 && i < text.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    text = text.slice(1, -1).trim();
  }
  return text;
};

const normalizeDefault = (value: string | null) => {
  if (value === null) return null;
  const text = unwrap(value);
  return /^null$/i.test(text) ? null : text;
};

export const mssql: Introspector = {
  async listTables(db) {
    const rows = await db.raw<{ name: string }>(
      sql`select name from sys.tables where schema_id = schema_id() and is_ms_shipped = 0`
    );
    return rows.map((row) => row.name);
  },

  async hasTable(db, table) {
    const rows = await db.raw(sql`select 1 as found from sys.tables t where ${inTable(table)}`);
    return rows.length > 0;
  },

  async hasColumn(db, table, column) {
    const rows = await db.raw(
      sql`select 1 as found from sys.columns c join sys.tables t on t.object_id = c.object_id
        where ${inTable(table)} and c.name = ${column}`
    );
    return rows.length > 0;
  },

  async describeTable(db, table) {
    const found = await db.raw<{ name: string }>(sql`select t.name as name from sys.tables t where ${inTable(table)}`);
    if (!found.length) return undefined;
    const { name } = found[0];

    const columnRows = await db.raw<{
      name: string;
      type_name: string;
      max_length: number;
      numeric_precision: number;
      numeric_scale: number;
      is_nullable: unknown;
      is_identity: unknown;
      default_value: string | null;
    }>(
      sql`select c.name as name, type_name(c.user_type_id) as type_name, c.max_length as max_length,
          c.precision as numeric_precision, c.scale as numeric_scale, c.is_nullable as is_nullable,
          c.is_identity as is_identity, d.definition as default_value
        from sys.columns c
        join sys.tables t on t.object_id = c.object_id
        left join sys.default_constraints d on d.object_id = c.default_object_id
        where ${inTable(name)}
        order by c.column_id`
    );

    // key_ordinal 0 marks an INCLUDE column, which is not part of the key.
    const indexRows = await db.raw<{
      name: string;
      is_primary_key: unknown;
      is_unique: unknown;
      system_named: unknown;
      filter: string | null;
      column_name: string;
    }>(
      sql`select i.name as name, i.is_primary_key as is_primary_key, i.is_unique as is_unique,
          k.is_system_named as system_named, i.filter_definition as filter, c.name as column_name
        from sys.indexes i
        join sys.tables t on t.object_id = i.object_id
        join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
        join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
        left join sys.key_constraints k on k.parent_object_id = i.object_id and k.unique_index_id = i.index_id
        where ${inTable(name)} and i.type > 0 and i.is_hypothetical = 0 and ic.key_ordinal > 0
        order by i.name, ic.key_ordinal`
    );

    const foreignKeyRows = await db.raw<{
      name: string;
      system_named: unknown;
      column_name: string;
      referenced_table: string;
      referenced_column: string;
      on_delete: string;
      on_update: string;
    }>(
      sql`select fk.name as name, fk.is_system_named as system_named, pc.name as column_name,
          case when rt.schema_id = schema_id() then rt.name else schema_name(rt.schema_id) + '.' + rt.name end as referenced_table,
          rc.name as referenced_column,
          fk.delete_referential_action_desc as on_delete, fk.update_referential_action_desc as on_update
        from sys.foreign_keys fk
        join sys.tables t on t.object_id = fk.parent_object_id
        join sys.foreign_key_columns fkc on fkc.constraint_object_id = fk.object_id
        join sys.columns pc on pc.object_id = fkc.parent_object_id and pc.column_id = fkc.parent_column_id
        join sys.tables rt on rt.object_id = fk.referenced_object_id
        join sys.columns rc on rc.object_id = fkc.referenced_object_id and rc.column_id = fkc.referenced_column_id
        where ${inTable(name)}
        order by fk.name, fkc.constraint_column_id`
    );

    const primaryKey = indexRows.filter((row) => truthy(row.is_primary_key)).map((row) => row.column_name);

    const columns = columnRows.map((row): ColumnInfo => {
      const type = row.type_name.toLowerCase();
      const rawType = rawTypeOf(type, row.max_length, row.numeric_precision, row.numeric_scale);
      const sizes = typeSizes(type, /\((.*)\)/.exec(rawType)?.[1].split(",") ?? []);
      return {
        name: row.name,
        type,
        rawType,
        ...sizes,
        nullable: truthy(row.is_nullable),
        default: normalizeDefault(row.default_value),
        autoIncrement: truthy(row.is_identity),
        primaryKey: primaryKey.includes(row.name),
      };
    });

    const indexes = [...groupBy(indexRows.filter((row) => !truthy(row.is_primary_key)), (row) => row.name)].map(
      ([indexName, rows]): IndexInfo => ({
        name: indexName,
        columns: rows.map((row) => row.column_name),
        unique: truthy(rows[0].is_unique),
        // Stored parenthesized like a default: ([email] IS NOT NULL).
        ...(rows[0].filter === null ? {} : { where: unwrap(rows[0].filter) }),
        ...(truthy(rows[0].system_named) ? { systemNamed: true as const } : {}),
      })
    );

    const foreignKeys = [...groupBy(foreignKeyRows, (row) => row.name)].map(
      ([keyName, rows]): ForeignKeyInfo => ({
        name: keyName,
        columns: rows.map((row) => row.column_name),
        referencedTable: rows[0].referenced_table,
        referencedColumns: rows.map((row) => row.referenced_column),
        onDelete: referentialAction(rows[0].on_delete),
        onUpdate: referentialAction(rows[0].on_update),
        ...(truthy(rows[0].system_named) ? { systemNamed: true as const } : {}),
      })
    );

    const checkRows = await db.raw<{ name: string; definition: string; system_named: unknown }>(
      sql`select cc.name as name, cc.definition as definition, cc.is_system_named as system_named
        from sys.check_constraints cc join sys.tables t on t.object_id = cc.parent_object_id
        where ${inTable(name)}`
    );
    const checks = checkRows.map(
      (row): CheckInfo => ({
        name: row.name,
        expression: unwrap(row.definition),
        ...(truthy(row.system_named) ? { systemNamed: true as const } : {}),
      })
    );

    return {
      name,
      columns,
      primaryKey,
      indexes: sortIndexes(indexes),
      foreignKeys: sortForeignKeys(foreignKeys),
      checks: sortChecks(checks),
    };
  },
};
