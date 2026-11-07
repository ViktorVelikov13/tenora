import { compareText } from "./normalize";
import type { CheckInfo, ColumnInfo, CompareOptions, ForeignKeyInfo, IndexInfo, SchemaInfo, TableInfo } from "./types";

const quote = (name: string) => `"${name}"`;
const list = (names: string[]) => `(${names.join(", ")})`;

/**
 * Pairs items of `a` and `b` with the same key, in order, and removes them from both lists. Items whose key is
 * undefined are never paired.
 */
const pairBy = <T>(a: T[], b: T[], key: (item: T) => string | undefined): Array<[T, T]> => {
  const pairs: Array<[T, T]> = [];
  for (let i = 0; i < a.length; i++) {
    const k = key(a[i]);
    if (k === undefined) continue;
    const j = b.findIndex((item) => key(item) === k);
    if (j < 0) continue;
    pairs.push([a[i], b[j]]);
    a.splice(i--, 1);
    b.splice(j, 1);
  }
  return pairs;
};

type Constraint = { name: string | null; systemNamed?: true };

/** A name compares as itself, except one SQL Server generated, which only says that the DDL gave none. */
const comparableName = (item: Constraint) => (item.systemNamed ? "(generated)" : item.name);

const naming = (item: Constraint) =>
  item.name === null
    ? "unnamed"
    : item.systemNamed
      ? `named ${quote(item.name)} by the server`
      : `named ${quote(item.name)}`;

/**
 * Matches the indexes, foreign keys or checks of one table: by name first when names matter, then by what they cover
 * with the same attributes, then by what they cover alone. Returns the pairs and what is left on each side.
 */
const match = <T extends Constraint>(
  a: T[],
  b: T[],
  ignoreNames: boolean,
  covers: (item: T) => string,
  attributes: (item: T) => string
) => {
  const left = [...a];
  const right = [...b];
  const byName = ignoreNames
    ? []
    : pairBy(left, right, (item) => (item.name === null || item.systemNamed ? undefined : item.name));
  const byDefinition = [
    ...pairBy(left, right, (item) => `${covers(item)} ${attributes(item)}`),
    ...pairBy(left, right, covers),
  ];
  return { byName, byDefinition, left, right };
};

const compareColumns = (table: string, a: ColumnInfo, b: ColumnInfo, la: string, lb: string, out: string[]) => {
  const subject = `column ${quote(table)}.${quote(a.name)}`;
  if (a.rawType !== b.rawType || a.type !== b.type) {
    const [ta, tb] = a.rawType !== b.rawType ? [a.rawType, b.rawType] : [a.type, b.type];
    out.push(`${subject}: type ${ta} in ${la}, ${tb} in ${lb}`);
  }
  if (a.nullable !== b.nullable) {
    const state = (nullable: boolean) => (nullable ? "nullable" : "not null");
    out.push(`${subject}: ${state(a.nullable)} in ${la}, ${state(b.nullable)} in ${lb}`);
  }
  if (a.default !== b.default) {
    const value = (value: string | null) => (value === null ? "no default" : `default ${value}`);
    out.push(`${subject}: ${value(a.default)} in ${la}, ${value(b.default)} in ${lb}`);
  }
  if (a.autoIncrement !== b.autoIncrement) {
    const state = (on: boolean) => (on ? "auto-increment" : "not auto-increment");
    out.push(`${subject}: ${state(a.autoIncrement)} in ${la}, ${state(b.autoIncrement)} in ${lb}`);
  }
};

const condition = (index: IndexInfo) => (index.where === undefined ? "no condition" : `where ${index.where}`);

const describeIndex = (table: string, index: IndexInfo) =>
  `${index.unique ? "unique index" : "index"} ${quote(index.name)} on ${quote(table)} ${list(index.columns)}` +
  (index.where === undefined ? "" : ` where ${index.where}`);

const describeForeignKey = (table: string, fk: ForeignKeyInfo) =>
  `foreign key${fk.name === null ? "" : ` ${quote(fk.name)}`} on ${quote(table)} ${list(fk.columns)} ` +
  `references ${quote(fk.referencedTable)} ${list(fk.referencedColumns)}`;

const compareIndexes = (table: string, a: TableInfo, b: TableInfo, options: Required<CompareOptions>, out: string[]) => {
  const [la, lb] = options.labels;
  const covers = (index: IndexInfo) => list(index.columns);
  const { byName, byDefinition, left, right } = match(
    a.indexes,
    b.indexes,
    options.ignoreNames,
    covers,
    (index) => `${index.unique} ${condition(index)}`
  );
  for (const [x, y] of [...byName, ...byDefinition]) {
    const subject = `index ${quote(x.name)} on ${quote(table)}`;
    if (!options.ignoreNames && comparableName(x) !== comparableName(y)) {
      out.push(`index on ${quote(table)} ${covers(x)}: ${naming(x)} in ${la}, ${naming(y)} in ${lb}`);
    }
    if (covers(x) !== covers(y)) out.push(`${subject}: columns ${covers(x)} in ${la}, ${covers(y)} in ${lb}`);
    if (x.unique !== y.unique) {
      const state = (unique: boolean) => (unique ? "unique" : "not unique");
      out.push(`${subject}: ${state(x.unique)} in ${la}, ${state(y.unique)} in ${lb}`);
    }
    if (x.where !== y.where) out.push(`${subject}: ${condition(x)} in ${la}, ${condition(y)} in ${lb}`);
  }
  for (const index of left) out.push(`${describeIndex(table, index)} exists only in ${la}`);
  for (const index of right) out.push(`${describeIndex(table, index)} exists only in ${lb}`);
};

const compareForeignKeys = (
  table: string,
  a: TableInfo,
  b: TableInfo,
  options: Required<CompareOptions>,
  out: string[]
) => {
  const [la, lb] = options.labels;
  const covers = (fk: ForeignKeyInfo) =>
    `${list(fk.columns)} references ${quote(fk.referencedTable)} ${list(fk.referencedColumns)}`;
  const { byName, byDefinition, left, right } = match(
    a.foreignKeys,
    b.foreignKeys,
    options.ignoreNames,
    covers,
    (fk) => `${fk.onDelete}/${fk.onUpdate}`
  );
  for (const [x, y] of [...byName, ...byDefinition]) {
    const subject = x.name === null ? describeForeignKey(table, x) : `foreign key ${quote(x.name)} on ${quote(table)}`;
    if (!options.ignoreNames && comparableName(x) !== comparableName(y)) {
      out.push(`foreign key on ${quote(table)} ${covers(x)}: ${naming(x)} in ${la}, ${naming(y)} in ${lb}`);
    }
    if (covers(x) !== covers(y)) out.push(`${subject}: ${covers(x)} in ${la}, ${covers(y)} in ${lb}`);
    if (x.onDelete !== y.onDelete) out.push(`${subject}: on delete ${x.onDelete} in ${la}, ${y.onDelete} in ${lb}`);
    if (x.onUpdate !== y.onUpdate) out.push(`${subject}: on update ${x.onUpdate} in ${la}, ${y.onUpdate} in ${lb}`);
  }
  for (const fk of left) out.push(`${describeForeignKey(table, fk)} exists only in ${la}`);
  for (const fk of right) out.push(`${describeForeignKey(table, fk)} exists only in ${lb}`);
};

const compareChecks = (table: string, a: TableInfo, b: TableInfo, options: Required<CompareOptions>, out: string[]) => {
  const [la, lb] = options.labels;
  const covers = (check: CheckInfo) => `(${check.expression})`;
  const describe = (check: CheckInfo) =>
    `check${check.name === null ? "" : ` ${quote(check.name)}`} on ${quote(table)} ${covers(check)}`;
  const { byName, byDefinition, left, right } = match(a.checks, b.checks, options.ignoreNames, covers, () => "");
  for (const [x, y] of [...byName, ...byDefinition]) {
    if (!options.ignoreNames && comparableName(x) !== comparableName(y)) {
      out.push(`check on ${quote(table)} ${covers(x)}: ${naming(x)} in ${la}, ${naming(y)} in ${lb}`);
    }
    if (covers(x) !== covers(y)) {
      out.push(`check ${quote(x.name ?? "")} on ${quote(table)}: ${covers(x)} in ${la}, ${covers(y)} in ${lb}`);
    }
  }
  for (const check of left) out.push(`${describe(check)} exists only in ${la}`);
  for (const check of right) out.push(`${describe(check)} exists only in ${lb}`);
};

const compareTables = (a: TableInfo, b: TableInfo, options: Required<CompareOptions>, out: string[]) => {
  const [la, lb] = options.labels;
  const table = a.name;

  // Columns match by name; their order is not compared.
  const columnsB = new Map(b.columns.map((column) => [column.name, column]));
  for (const column of a.columns) {
    const other = columnsB.get(column.name);
    if (other) compareColumns(table, column, other, la, lb, out);
    else out.push(`column ${quote(table)}.${quote(column.name)} exists only in ${la}`);
  }
  const namesA = new Set(a.columns.map((column) => column.name));
  for (const column of b.columns) {
    if (!namesA.has(column.name)) out.push(`column ${quote(table)}.${quote(column.name)} exists only in ${lb}`);
  }

  if (a.primaryKey.join() !== b.primaryKey.join()) {
    const key = (columns: string[]) => (columns.length ? list(columns) : "none");
    out.push(`primary key of ${quote(table)}: ${key(a.primaryKey)} in ${la}, ${key(b.primaryKey)} in ${lb}`);
  }

  compareIndexes(table, a, b, options, out);
  compareForeignKeys(table, a, b, options, out);
  compareChecks(table, a, b, options, out);
};

/**
 * The differences between two schemas from describeSchema(), as sentences a person can read; empty when they
 * match. Both must come from the same dialect, since types and defaults are compared as each database reports them.
 * The order of tables, columns, indexes, foreign keys and checks does not matter.
 */
export const compareSchemas = (a: SchemaInfo, b: SchemaInfo, options: CompareOptions = {}): string[] => {
  if (a.dialect !== b.dialect) {
    throw new Error(`Tenora: cannot compare a ${a.dialect} schema with a ${b.dialect} schema.`);
  }
  const resolved: Required<CompareOptions> = {
    ignoreNames: options.ignoreNames ?? false,
    labels: options.labels ?? ["a", "b"],
  };
  const [la, lb] = resolved.labels;
  const out: string[] = [];
  const tablesA = new Map(a.tables.map((table) => [table.name, table]));
  const tablesB = new Map(b.tables.map((table) => [table.name, table]));
  const names = [...new Set([...tablesA.keys(), ...tablesB.keys()])].sort(compareText);
  for (const name of names) {
    const x = tablesA.get(name);
    const y = tablesB.get(name);
    if (x && y) compareTables(x, y, resolved, out);
    else out.push(`table ${quote(name)} exists only in ${x ? la : lb}`);
  }
  return out;
};
