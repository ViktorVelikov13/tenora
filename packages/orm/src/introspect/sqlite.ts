import { sql } from "../sql";
import { groupBy, referentialAction, sortForeignKeys, sortIndexes, splitType, truthy, typeSizes } from "./normalize";
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, Introspector } from "./types";

// The pragmas leave out two things the schema says: foreign key names and the AUTOINCREMENT keyword. Both are read
// from the CREATE TABLE statement SQLite keeps in sqlite_master, with a tokenizer that knows SQLite's quoting.

type Token = { kind: "word" | "quoted" | "string" | "punct"; value: string; start: number; end: number };

const WORD = /[\w$\u0080-￿]/;

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (ch === '"' || ch === "`" || ch === "'") {
      // A doubled quote is the quote itself.
      let j = i + 1;
      let value = "";
      while (j < text.length) {
        if (text[j] === ch) {
          if (text[j + 1] !== ch) break;
          j++;
        }
        value += text[j++];
      }
      tokens.push({ kind: ch === "'" ? "string" : "quoted", value, start: i, end: j + 1 });
      i = j + 1;
    } else if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      const end = close < 0 ? text.length : close;
      tokens.push({ kind: "quoted", value: text.slice(i + 1, end), start: i, end: end + 1 });
      i = end + 1;
    } else if (WORD.test(ch)) {
      let j = i;
      while (j < text.length && WORD.test(text[j])) j++;
      tokens.push({ kind: "word", value: text.slice(i, j), start: i, end: j });
      i = j;
    } else {
      tokens.push({ kind: "punct", value: ch, start: i, end: i + 1 });
      i++;
    }
  }
  return tokens;
};

const isWord = (token: Token | undefined, word: string) =>
  token?.kind === "word" && token.value.toLowerCase() === word;

const identifier = (token: Token | undefined) =>
  token && (token.kind === "word" || token.kind === "quoted" || token.kind === "string") ? token.value : undefined;

/** The comma-separated items of the parenthesized list that opens at `open`, each as its tokens. */
const listItems = (tokens: Token[], open: number): Token[][] => {
  const items: Token[][] = [[]];
  let depth = 0;
  for (let i = open + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "punct" && token.value === "(") depth++;
    if (token.kind === "punct" && token.value === ")") {
      if (depth === 0) return items;
      depth--;
    }
    if (depth === 0 && token.kind === "punct" && token.value === ",") items.push([]);
    else items[items.length - 1].push(token);
  }
  return items;
};

const firstParen = (tokens: Token[], from = 0) =>
  tokens.findIndex((token, i) => i >= from && token.kind === "punct" && token.value === "(");

/** The index of the parenthesis that closes the one at `open`. */
const closingParen = (tokens: Token[], open: number) => {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].kind !== "punct") continue;
    if (tokens[i].value === "(") depth++;
    if (tokens[i].value === ")" && --depth === 0) return i;
  }
  return tokens.length;
};

/** The names in a parenthesized column list starting at `open`. */
const nameList = (tokens: Token[], open: number) =>
  listItems(tokens, open).map((item) => identifier(item[0]) ?? "");

type DeclaredForeignKey = { name: string | null; columns: string[]; table: string };

/** Named foreign keys, AUTOINCREMENT columns and WITHOUT ROWID, as declared in a CREATE TABLE statement. */
const parseCreateTable = (text: string) => {
  const tokens = tokenize(text);
  const foreignKeys: DeclaredForeignKey[] = [];
  const autoIncrement = new Set<string>();
  const open = firstParen(tokens);
  if (open < 0) return { foreignKeys, autoIncrement, withoutRowid: false };
  const options = tokens.slice(closingParen(tokens, open) + 1);
  const withoutRowid = options.some((token, i) => isWord(token, "without") && isWord(options[i + 1], "rowid"));

  for (const item of listItems(tokens, open)) {
    // Only what is outside parentheses is a clause; skipping the rest keeps CHECK and DEFAULT bodies out.
    const clause: Token[] = [];
    let depth = 0;
    for (const token of item) {
      if (token.kind === "punct" && token.value === ")") depth--;
      if (depth === 0) clause.push(token);
      if (token.kind === "punct" && token.value === "(") depth++;
    }

    let start = 0;
    let name: string | null = null;
    if (isWord(clause[0], "constraint")) {
      name = identifier(clause[1]) ?? null;
      start = 2;
    }
    if (isWord(clause[start], "foreign")) {
      // CONSTRAINT name FOREIGN KEY (columns) REFERENCES table ...
      const columnsOpen = item.indexOf(clause[start + 2]);
      const references = clause.findIndex((token) => isWord(token, "references"));
      foreignKeys.push({
        name,
        columns: nameList(item, columnsOpen),
        table: identifier(clause[references + 1]) ?? "",
      });
      continue;
    }
    if (["primary", "unique", "check"].some((word) => isWord(clause[start], word))) continue;

    // A column: its name, then its type and constraints, where CONSTRAINT names only the constraint after it.
    const column = identifier(clause[0]) ?? "";
    for (let i = 1; i < clause.length; i++) {
      if (isWord(clause[i], "autoincrement")) autoIncrement.add(column.toLowerCase());
      if (isWord(clause[i], "references")) {
        const named = isWord(clause[i - 2], "constraint") ? (identifier(clause[i - 1]) ?? null) : null;
        foreignKeys.push({ name: named, columns: [column], table: identifier(clause[i + 1]) ?? "" });
      }
    }
  }
  return { foreignKeys, autoIncrement, withoutRowid };
};

/** The text of each key in a CREATE INDEX statement, for keys that are expressions. */
const indexKeyTexts = (text: string) => {
  const tokens = tokenize(text);
  const on = tokens.findIndex((token) => isWord(token, "on"));
  const open = firstParen(tokens, on);
  if (on < 0 || open < 0) return [];
  return listItems(tokens, open).map((item) =>
    item.length ? text.slice(item[0].start, item[item.length - 1].end) : ""
  );
};

/** SQLite type names are case-insensitive and kept as typed; "DECIMAL(8, 2)" becomes "decimal(8,2)". */
const normalizeType = (declared: string) =>
  declared
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();

const lower = (names: string[]) => names.map((name) => name.toLowerCase()).join(",");

export const sqlite: Introspector = {
  async listTables(db) {
    const rows = await db.raw<{ name: string }>(
      sql`select name from main.sqlite_master where type = 'table' and substr(name, 1, 7) <> 'sqlite_'`
    );
    return rows.map((row) => row.name);
  },

  async hasTable(db, table) {
    const rows = await db.raw(
      sql`select 1 as found from main.sqlite_master where type = 'table' and name = ${table} collate nocase`
    );
    return rows.length > 0;
  },

  async hasColumn(db, table, column) {
    if (!(await sqlite.hasTable(db, table))) return false;
    const rows = await db.raw(
      sql`select 1 as found from pragma_table_info(${table}, 'main') where name = ${column} collate nocase`
    );
    return rows.length > 0;
  },

  async describeTable(db, table) {
    const found = await db.raw<{ name: string; sql: string | null }>(
      sql`select name, sql from main.sqlite_master where type = 'table' and name = ${table} collate nocase`
    );
    if (!found.length) return undefined;
    const { name } = found[0];
    const declared = parseCreateTable(found[0].sql ?? "");

    const columnRows = await db.raw<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>(sql`select name, type, "notnull", dflt_value, pk from pragma_table_info(${name}, 'main') order by cid`);

    const primaryKey = columnRows
      .filter((row) => row.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((row) => row.name);
    // An INTEGER PRIMARY KEY is the rowid, which cannot be null even where the DDL does not say NOT NULL.
    const rowid =
      primaryKey.length === 1 && !declared.withoutRowid
        ? columnRows.find((row) => row.name === primaryKey[0] && /^integer$/i.test(row.type))?.name
        : undefined;

    const columns = columnRows.map((row): ColumnInfo => {
      const rawType = normalizeType(row.type ?? "");
      const { base, args } = splitType(rawType);
      return {
        name: row.name,
        type: base,
        rawType,
        ...typeSizes(base, args),
        nullable: !truthy(row.notnull) && row.name !== rowid,
        default: row.dflt_value === null || /^null$/i.test(row.dflt_value) ? null : row.dflt_value,
        autoIncrement: declared.autoIncrement.has(row.name.toLowerCase()),
        primaryKey: row.pk > 0,
      };
    });

    // The primary key's own index (origin "pk") is the primary key, not an index.
    const indexList = await db.raw<{ name: string; unique: number; origin: string }>(
      sql`select name, "unique", origin from pragma_index_list(${name}, 'main') where origin <> 'pk'`
    );
    const indexes: IndexInfo[] = [];
    for (const index of indexList) {
      // cid -2 marks an expression, whose text only the CREATE INDEX statement has.
      const keys = await db.raw<{ cid: number; name: string | null }>(
        sql`select cid, name from pragma_index_xinfo(${index.name}, 'main') where "key" = 1 order by seqno`
      );
      let texts: string[] = [];
      if (keys.some((key) => key.name === null)) {
        const statement = await db.raw<{ sql: string | null }>(
          sql`select sql from main.sqlite_master where type = 'index' and name = ${index.name}`
        );
        texts = indexKeyTexts(statement[0]?.sql ?? "");
      }
      indexes.push({
        name: index.name,
        columns: keys.map((key, i) => key.name ?? texts[i] ?? ""),
        unique: truthy(index.unique),
      });
    }

    const foreignKeyRows = await db.raw<{
      id: number;
      table: string;
      from: string;
      to: string | null;
      on_update: string;
      on_delete: string;
    }>(
      sql`select id, "table", "from", "to", on_update, on_delete from pragma_foreign_key_list(${name}, 'main') order by id, seq`
    );

    const unclaimed = [...declared.foreignKeys];
    const foreignKeys: ForeignKeyInfo[] = [];
    for (const rows of groupBy(foreignKeyRows, (row) => row.id).values()) {
      const referencedTable = rows[0].table;
      const columnNames = rows.map((row) => row.from);
      // REFERENCES users, without columns, means the referenced table's primary key.
      let referencedColumns = rows.map((row) => row.to);
      if (referencedColumns.some((column) => column === null)) {
        const keys = await db.raw<{ name: string }>(
          sql`select name from pragma_table_info(${referencedTable}, 'main') where pk > 0 order by pk`
        );
        referencedColumns = keys.map((key) => key.name);
      }
      // The pragma does not list keys in declaration order, so names are matched by what the key covers.
      const match = unclaimed.findIndex(
        (fk) =>
          lower(fk.columns) === lower(columnNames) && fk.table.toLowerCase() === referencedTable.toLowerCase()
      );
      const declaredName = match < 0 ? null : unclaimed.splice(match, 1)[0].name;
      foreignKeys.push({
        name: declaredName,
        columns: columnNames,
        referencedTable,
        referencedColumns: referencedColumns as string[],
        onDelete: referentialAction(rows[0].on_delete),
        onUpdate: referentialAction(rows[0].on_update),
      });
    }

    return { name, columns, primaryKey, indexes: sortIndexes(indexes), foreignKeys: sortForeignKeys(foreignKeys) };
  },
};

/** @internal Exposed for tests of the parser. */
export const parseSqliteCreateTable = parseCreateTable;
