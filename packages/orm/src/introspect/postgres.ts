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
import type { ColumnInfo, Introspector, ReferentialAction } from "./types";

// pg_catalog rather than information_schema for constraints: constraint names are unique per table, not per schema,
// so joining information_schema views by constraint name can pair the wrong rows.

const tableOid = (table: string) =>
  sql`(select c.oid from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and c.relname = ${table} and c.relkind in ('r', 'p'))`;

/** format_type() spells types out; the base type uses the short names people write. */
const SHORT_NAMES: Record<string, string> = {
  "character varying": "varchar",
  character: "char",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamptz",
  "time without time zone": "time",
  "time with time zone": "timetz",
  "bit varying": "varbit",
};

const baseType = (rawType: string) => {
  const { base, args } = splitType(rawType);
  const array = base.endsWith("[]") ? "[]" : "";
  const element = array ? base.slice(0, -2) : base;
  return { type: (SHORT_NAMES[element] ?? element) + array, args };
};

const ACTIONS: Record<string, ReferentialAction> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

/**
 * Postgres casts literal defaults to the column type and names the sequence as a regclass:
 * `'new'::character varying` → `'new'`, `nextval('users_id_seq'::regclass)` → `nextval('users_id_seq')`.
 */
const normalizeDefault = (value: string | null): string | null => {
  if (value === null) return null;
  const sequence = /^nextval\(('(?:[^']|'')*')::regclass\)$/.exec(value);
  if (sequence) return `nextval(${sequence[1]})`;
  if (/^NULL::[a-z_][\w\s."[\]]*$/i.test(value)) return null;
  const literal = /^('(?:[^']|'')*')::[a-z_][\w\s."[\]]*$/i.exec(value);
  return literal ? literal[1] : value;
};

export const postgres: Introspector = {
  async listTables(db) {
    const rows = await db.raw<{ name: string }>(
      sql`select c.relname as name from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = current_schema() and c.relkind in ('r', 'p') and not c.relispartition`
    );
    return rows.map((row) => row.name);
  },

  async hasTable(db, table) {
    const rows = await db.raw(sql`select 1 as found where ${tableOid(table)} is not null`);
    return rows.length > 0;
  },

  async hasColumn(db, table, column) {
    const rows = await db.raw(
      sql`select 1 as found from pg_catalog.pg_attribute
        where attrelid = ${tableOid(table)} and attname = ${column} and attnum > 0 and not attisdropped`
    );
    return rows.length > 0;
  },

  async describeTable(db, table) {
    if (!(await postgres.hasTable(db, table))) return undefined;
    const oid = tableOid(table);

    // A generated column keeps its expression where defaults live; it is not a default.
    const columnRows = await db.raw<{
      name: string;
      raw_type: string;
      not_null: unknown;
      default_value: string | null;
      identity: string;
    }>(
      sql`select a.attname as name, format_type(a.atttypid, a.atttypmod) as raw_type, a.attnotnull as not_null,
          case when a.attgenerated = '' then pg_get_expr(d.adbin, d.adrelid) end as default_value,
          a.attidentity as identity
        from pg_catalog.pg_attribute a
        left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = ${oid} and a.attnum > 0 and not a.attisdropped
        order by a.attnum`
    );

    const primaryKey = (
      await db.raw<{ name: string }>(
        sql`select a.attname as name
          from pg_catalog.pg_constraint con
          cross join lateral unnest(con.conkey) with ordinality as k(attnum, position)
          join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
          where con.conrelid = ${oid} and con.contype = 'p'
          order by k.position`
      )
    ).map((row) => row.name);

    // An expression in an index has attnum 0; pg_get_indexdef() gives its text. INCLUDE columns are not keys.
    const indexRows = await db.raw<{ name: string; is_unique: unknown; predicate: string | null; column_name: string }>(
      sql`select ic.relname as name, i.indisunique as is_unique, pg_get_expr(i.indpred, i.indrelid, true) as predicate,
          case when k.attnum = 0 then pg_get_indexdef(i.indexrelid, k.position::int, true) else a.attname end as column_name
        from pg_catalog.pg_index i
        join pg_catalog.pg_class ic on ic.oid = i.indexrelid
        cross join lateral unnest(i.indkey) with ordinality as k(attnum, position)
        left join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        where i.indrelid = ${oid} and not i.indisprimary and k.position <= i.indnkeyatts
        order by ic.relname, k.position`
    );

    const foreignKeyRows = await db.raw<{
      name: string;
      column_name: string;
      referenced_table: string;
      referenced_column: string;
      on_delete: string;
      on_update: string;
    }>(
      sql`select con.conname as name, a.attname as column_name,
          case when rn.nspname = current_schema() then rc.relname else rn.nspname || '.' || rc.relname end as referenced_table,
          ra.attname as referenced_column, con.confdeltype as on_delete, con.confupdtype as on_update
        from pg_catalog.pg_constraint con
        join pg_catalog.pg_class rc on rc.oid = con.confrelid
        join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
        cross join lateral unnest(con.conkey, con.confkey) with ordinality as k(attnum, referenced_attnum, position)
        join pg_catalog.pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
        join pg_catalog.pg_attribute ra on ra.attrelid = con.confrelid and ra.attnum = k.referenced_attnum
        where con.conrelid = ${oid} and con.contype = 'f'
        order by con.conname, k.position`
    );

    // Only CHECK constraints: Postgres 18 lists NOT NULL constraints here too, as contype 'n'.
    const checkRows = await db.raw<{ name: string; definition: string }>(
      sql`select conname as name, pg_get_constraintdef(oid, true) as definition
        from pg_catalog.pg_constraint where conrelid = ${oid} and contype = 'c'`
    );

    const columns = columnRows.map((row): ColumnInfo => {
      const { type, args } = baseType(row.raw_type);
      const fromSequence = row.default_value?.startsWith("nextval(") ?? false;
      return {
        name: row.name,
        type,
        rawType: row.raw_type,
        ...typeSizes(type, args),
        nullable: !truthy(row.not_null),
        default: normalizeDefault(row.default_value),
        autoIncrement: row.identity === "a" || row.identity === "d" || fromSequence,
        primaryKey: primaryKey.includes(row.name),
      };
    });

    const indexes = [...groupBy(indexRows, (row) => row.name)].map(([indexName, rows]) => ({
      name: indexName,
      columns: rows.map((row) => row.column_name),
      unique: truthy(rows[0].is_unique),
      ...(rows[0].predicate === null ? {} : { where: rows[0].predicate }),
    }));

    const foreignKeys = [...groupBy(foreignKeyRows, (row) => row.name)].map(([keyName, rows]) => ({
      name: keyName,
      columns: rows.map((row) => row.column_name),
      referencedTable: rows[0].referenced_table,
      referencedColumns: rows.map((row) => row.referenced_column),
      onDelete: ACTIONS[rows[0].on_delete] ?? referentialAction(rows[0].on_delete),
      onUpdate: ACTIONS[rows[0].on_update] ?? referentialAction(rows[0].on_update),
    }));

    // CHECK (status = 'new'::text) → status = 'new'::text
    const checks = checkRows.map((row) => ({
      name: row.name,
      expression: /^CHECK \((.*)\)$/s.exec(row.definition)?.[1] ?? row.definition,
    }));

    // The lookup matched the name exactly, so it is the stored name.
    return {
      name: table,
      columns,
      primaryKey,
      indexes: sortIndexes(indexes),
      foreignKeys: sortForeignKeys(foreignKeys),
      checks: sortChecks(checks),
    };
  },
};
