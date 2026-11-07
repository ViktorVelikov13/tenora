/**
 * SQLite table rebuilds. SQLite alters little in place (ADD COLUMN, RENAME, DROP COLUMN of a column nothing depends
 * on), so other changes create a new table, copy the rows and swap it in, following the 12 steps of
 * https://www.sqlite.org/lang_altertable.html#otheralter.
 *
 * The current definition comes from the table's pragmas and from its CREATE TABLE text in sqlite_schema, which holds
 * what the pragmas leave out (CHECK constraints, COLLATE, constraint names, AUTOINCREMENT). A column definition the
 * change does not touch is copied as written.
 */
import { sql } from "../sql";
import type { SchemaRunner } from "./runner";

type TokenKind = "word" | "quoted" | "string" | "group" | "number" | "punct";
type Token = { readonly kind: TokenKind; readonly text: string; readonly start: number; readonly end: number };

const WORD = /[A-Za-z0-9_$\u0080-￿]/;
const DIGIT = /[0-9]/;
const SPACE = /\s/;

const unreadable = (what: string) =>
  new Error(`Tenora: could not read the SQLite definition (${what}); the table cannot be rebuilt.`);

/** The index after a quoted run starting at `start`; a doubled quote inside is an escaped quote. */
const closeQuote = (input: string, start: number, quote: string): number => {
  for (let i = start + 1; i < input.length; i++) {
    if (input[i] !== quote) continue;
    if (input[i + 1] === quote) i++;
    else return i + 1;
  }
  throw unreadable("an unterminated quote");
};

const skipSpace = (input: string, start: number): number => {
  let i = start;
  while (i < input.length) {
    if (SPACE.test(input[i])) i++;
    else if (input.startsWith("--", i)) {
      const end = input.indexOf("\n", i);
      i = end === -1 ? input.length : end + 1;
    } else if (input.startsWith("/*", i)) {
      const end = input.indexOf("*/", i + 2);
      i = end === -1 ? input.length : end + 2;
    } else break;
  }
  return i;
};

const closeBracket = (input: string, start: number) => {
  const end = input.indexOf("]", start);
  if (end === -1) throw unreadable("an unterminated [identifier]");
  return end + 1;
};

const closeGroup = (input: string, start: number): number => {
  let depth = 0;
  let i = start;
  while (i < input.length) {
    i = skipSpace(input, i);
    const c = input[i];
    if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      depth--;
      i++;
      if (depth === 0) return i;
    } else if (c === "'" || c === '"' || c === "`") i = closeQuote(input, i, c);
    else if (c === "[") i = closeBracket(input, i);
    else i++;
  }
  throw unreadable("unbalanced parentheses");
};

const scan = (input: string, start: number): Token => {
  const c = input[start];
  let end: number;
  let kind: TokenKind;
  if (c === "'") [kind, end] = ["string", closeQuote(input, start, c)];
  else if (c === '"' || c === "`") [kind, end] = ["quoted", closeQuote(input, start, c)];
  else if (c === "[") [kind, end] = ["quoted", closeBracket(input, start)];
  else if (c === "(") [kind, end] = ["group", closeGroup(input, start)];
  else if (DIGIT.test(c) || (c === "." && DIGIT.test(input[start + 1] ?? ""))) {
    kind = "number";
    end = start + 1;
    while (end < input.length && (WORD.test(input[end]) || input[end] === ".")) end++;
  } else if (WORD.test(c)) {
    kind = "word";
    end = start + 1;
    while (end < input.length && WORD.test(input[end])) end++;
  } else [kind, end] = ["punct", start + 1];
  return { kind, text: input.slice(start, end), start, end };
};

/** Splits SQL into tokens; a parenthesized group stays one token, so a list's commas are the top-level ones. */
export const tokenize = (input: string): Token[] => {
  const tokens: Token[] = [];
  let i = skipSpace(input, 0);
  while (i < input.length) {
    const token = scan(input, i);
    tokens.push(token);
    i = skipSpace(input, token.end);
  }
  return tokens;
};

const upper = (token: Token | undefined) => (token?.kind === "word" ? token.text.toUpperCase() : "");

/** The name a token stands for: quotes removed, a word as it is. */
export const unquote = (token: Token): string => {
  const { text } = token;
  if (token.kind === "quoted") {
    if (text[0] === "[") return text.slice(1, -1);
    return text.slice(1, -1).split(text[0] + text[0]).join(text[0]);
  }
  if (token.kind === "string") return text.slice(1, -1).replace(/''/g, "'");
  return text;
};

type Item = { readonly text: string; readonly tokens: Token[] };

/** The items of a comma-separated list, each with its original text. */
const listItems = (input: string): Item[] => {
  const items: Item[] = [];
  let current: Token[] = [];
  const close = () => {
    if (current.length) {
      const text = input.slice(current[0].start, current[current.length - 1].end);
      // Offsets relative to the item's own text.
      const base = current[0].start;
      items.push({
        text,
        tokens: current.map((token) => ({ ...token, start: token.start - base, end: token.end - base })),
      });
    }
    current = [];
  };
  for (const token of tokenize(input)) {
    if (token.kind === "punct" && token.text === ",") close();
    else current.push(token);
  }
  close();
  return items;
};

/** The column names in a group such as `("a", "b" desc)`; an expression gives undefined. */
const groupColumns = (group: Token): (string | undefined)[] =>
  listItems(group.text.slice(1, -1)).map(({ tokens }) =>
    tokens.length && (tokens[0].kind === "word" || tokens[0].kind === "quoted" || tokens[0].kind === "string")
      ? unquote(tokens[0])
      : undefined
  );

export const sameName = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

export const hasName = (list: readonly string[], name: string | undefined) => list.some((item) => sameName(item, name));

// Column constraints, in the order Knex's SQLite compiler writes them.
export type ClauseKind =
  | "primary"
  | "notnull"
  | "null"
  | "unique"
  | "check"
  | "default"
  | "collate"
  | "references"
  | "generated"
  | "other";

export const CLAUSE_ORDER: readonly ClauseKind[] = [
  "primary",
  "notnull",
  "null",
  "unique",
  "check",
  "default",
  "collate",
  "references",
  "generated",
  "other",
];

export type Clause = {
  readonly kind: ClauseKind;
  /** the name from a CONSTRAINT prefix */
  readonly name?: string;
  readonly text: string;
  /** for a REFERENCES clause */
  readonly references?: { table: string; columns: (string | undefined)[] };
};

export type ColumnDefinition = {
  readonly name: string;
  readonly nameText: string;
  readonly type: string;
  readonly clauses: readonly Clause[];
  readonly text: string;
};

export type TableConstraint = {
  readonly kind: "primary" | "unique" | "check" | "foreign" | "other";
  readonly name?: string;
  readonly columns: (string | undefined)[];
  readonly references?: { table: string; columns: (string | undefined)[] };
  readonly text: string;
};

export type TableDefinition = {
  readonly columns: readonly ColumnDefinition[];
  readonly constraints: readonly TableConstraint[];
  /** what follows the column list, such as WITHOUT ROWID or STRICT */
  readonly options: string;
};

const CLAUSE_KINDS: Record<string, ClauseKind> = {
  PRIMARY: "primary",
  NOT: "notnull",
  NULL: "null",
  UNIQUE: "unique",
  CHECK: "check",
  DEFAULT: "default",
  COLLATE: "collate",
  REFERENCES: "references",
  GENERATED: "generated",
  AS: "generated",
};

/** Whether the token at `i` starts a new column constraint. */
const startsClause = (tokens: Token[], i: number): boolean => {
  const word = upper(tokens[i]);
  if (word === "CONSTRAINT") return true;
  if (!(word in CLAUSE_KINDS)) return false;
  const previous = upper(tokens[i - 1]);
  // ON DELETE SET NULL / SET DEFAULT, NOT DEFERRABLE and GENERATED ALWAYS AS stay in their clause.
  if ((word === "NULL" || word === "DEFAULT") && previous === "SET") return false;
  if (word === "NOT") return upper(tokens[i + 1]) === "NULL";
  if (word === "AS") return previous !== "ALWAYS";
  return true;
};

const referencesAt = (tokens: Token[], index: number) => {
  const table = tokens[index + 1];
  if (!table) return undefined;
  const group = tokens[index + 2]?.kind === "group" ? tokens[index + 2] : undefined;
  return { table: unquote(table), columns: group ? groupColumns(group) : [] };
};

const parseColumn = ({ text, tokens }: Item): ColumnDefinition => {
  const [nameToken] = tokens;
  let i = 1;
  while (i < tokens.length && !startsClause(tokens, i)) i++;
  const type = i > 1 ? text.slice(tokens[1].start, tokens[i - 1].end) : "";
  const clauses: Clause[] = [];
  while (i < tokens.length) {
    const start = i;
    let name: string | undefined;
    if (upper(tokens[i]) === "CONSTRAINT") {
      name = tokens[i + 1] ? unquote(tokens[i + 1]) : undefined;
      i += 2;
    }
    const kind = CLAUSE_KINDS[upper(tokens[i])] ?? "other";
    const keyword = i;
    i++;
    if (kind === "default") {
      // One value: DEFAULT NULL is a default, not a NULL constraint.
      if (tokens[i]?.kind === "punct" && (tokens[i].text === "-" || tokens[i].text === "+")) i++;
      i++;
    } else if (kind === "notnull" || kind === "collate") i++;
    while (i < tokens.length && !startsClause(tokens, i)) i++;
    const end = Math.min(i, tokens.length) - 1;
    clauses.push({
      kind,
      name,
      text: text.slice(tokens[start].start, tokens[end].end),
      references: kind === "references" ? referencesAt(tokens, keyword) : undefined,
    });
  }
  return { name: unquote(nameToken), nameText: nameToken.text, type, clauses, text };
};

const TABLE_CONSTRAINTS = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]);

const parseTableConstraint = ({ text, tokens }: Item): TableConstraint => {
  let i = 0;
  let name: string | undefined;
  if (upper(tokens[0]) === "CONSTRAINT") {
    name = tokens[1] ? unquote(tokens[1]) : undefined;
    i = 2;
  }
  const word = upper(tokens[i]);
  const firstGroup = tokens.slice(i).find((token) => token.kind === "group");
  const columns = firstGroup && word !== "CHECK" ? groupColumns(firstGroup) : [];
  if (word === "FOREIGN") {
    const at = tokens.findIndex((token) => upper(token) === "REFERENCES");
    return { kind: "foreign", name, columns, references: at === -1 ? undefined : referencesAt(tokens, at), text };
  }
  const kind = word === "PRIMARY" ? "primary" : word === "UNIQUE" ? "unique" : word === "CHECK" ? "check" : "other";
  return { kind, name, columns, text };
};

export const parseCreateTable = (createSql: string): TableDefinition => {
  const tokens = tokenize(createSql);
  const body = tokens.find((token) => token.kind === "group");
  if (!body || upper(tokens[tokens.indexOf(body) + 1]) === "AS") throw unreadable("no column list");
  const columns: ColumnDefinition[] = [];
  const constraints: TableConstraint[] = [];
  for (const item of listItems(body.text.slice(1, -1))) {
    const [first] = item.tokens;
    if (first.kind === "word" && TABLE_CONSTRAINTS.has(first.text.toUpperCase())) {
      constraints.push(parseTableConstraint(item));
    } else {
      columns.push(parseColumn(item));
    }
  }
  return { columns, constraints, options: createSql.slice(body.end).trim() };
};

/** A column definition written from its parts, with the constraints in a fixed order. */
export const writeColumn = (nameText: string, type: string, clauses: readonly Clause[]): string => {
  const ordered = [...clauses].sort((a, b) => CLAUSE_ORDER.indexOf(a.kind) - CLAUSE_ORDER.indexOf(b.kind));
  return [nameText, type, ...ordered.map((clause) => clause.text)].filter(Boolean).join(" ");
};

export const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Rewrites a CREATE INDEX statement without the given columns; undefined when no column is left. */
const shrinkIndex = (indexSql: string, dropped: readonly string[]): string | undefined => {
  const tokens = tokenize(indexSql);
  const on = tokens.findIndex((token) => upper(token) === "ON");
  const group = tokens.slice(on + 1).find((token) => token.kind === "group");
  if (on === -1 || !group) throw unreadable("an index");
  const kept = listItems(group.text.slice(1, -1)).filter(({ tokens: parts }) => {
    const [first] = parts;
    return !(first && (first.kind === "word" || first.kind === "quoted") && hasName(dropped, unquote(first)));
  });
  if (!kept.length) return undefined;
  return `${indexSql.slice(0, group.start)}(${kept.map((item) => item.text).join(", ")})${indexSql.slice(group.end)}`;
};

const indexColumns = (indexSql: string): (string | undefined)[] => {
  const tokens = tokenize(indexSql);
  const on = tokens.findIndex((token) => upper(token) === "ON");
  const group = tokens.slice(on + 1).find((token) => token.kind === "group");
  return group ? groupColumns(group) : [];
};

type Row = Record<string, unknown>;

const pragma = async (runner: SchemaRunner, name: "foreign_keys" | "legacy_alter_table") =>
  Number(Object.values((await runner.query(sql`pragma ${sql.raw(name)}`))[0] ?? {})[0] ?? 0);

/** Tables whose foreign keys point at `table`, itself included. */
const referencingTables = async (runner: SchemaRunner, table: string): Promise<string[]> => {
  const rows = await runner.query(
    sql`select m.name as name from sqlite_schema as m, pragma_foreign_key_list(m.name) as f where m.type = 'table' and lower(f."table") = lower(${table})`
  );
  return [...new Set(rows.map((row) => String(row.name)))];
};

/**
 * Connections whose foreign key enforcement `withoutForeignKeyConstraints()` switched off. A rebuild inside it still
 * checks the keys at its end, as it would have with enforcement on.
 */
const suspended = new WeakMap<object, number>();

export const suspendForeignKeys = async <T>(runner: SchemaRunner, fn: () => Promise<T>): Promise<T> => {
  const { owner } = runner;
  const enabled = (await pragma(runner, "foreign_keys")) === 1;
  if (enabled) {
    await runner.query(sql`pragma foreign_keys = off`);
    if ((await pragma(runner, "foreign_keys")) === 1) {
      throw new Error(
        "Tenora: withoutForeignKeyConstraints() has to start outside a transaction; SQLite ignores PRAGMA foreign_keys inside one. Open the transaction inside its callback."
      );
    }
  }
  suspended.set(owner, (suspended.get(owner) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const depth = (suspended.get(owner) ?? 1) - 1;
    if (depth) suspended.set(owner, depth);
    else suspended.delete(owner);
    if (enabled) await runner.query(sql`pragma foreign_keys = on`);
  }
};

export type RebuildOptions = {
  /** columns the change drops; their data is not copied */
  readonly dropped?: readonly string[];
  /**
   * An index on a dropped column is dropped ("drop", as Postgres does), or kept with its other columns ("shrink", as
   * Knex does).
   */
  readonly indexes: "drop" | "shrink";
  /** Triggers on the table are recreated; Knex's rebuild loses them, which its compatible blueprint keeps doing. */
  readonly keepTriggers: boolean;
};

/**
 * Rebuilds `table` with the definition `change` returns, keeping its rows, indexes and foreign keys.
 *
 * Foreign key enforcement is switched off before the transaction, as SQLite requires; otherwise dropping the old table
 * would delete the rows of tables that reference it with ON DELETE CASCADE. SQLite ignores that switch inside an open
 * transaction, so there the rebuild only goes ahead when no table references this one.
 */
export const rebuildTable = async (
  runner: SchemaRunner,
  table: string,
  change: (definition: TableDefinition) => TableDefinition,
  options: RebuildOptions
): Promise<void> => {
  const enforced = (await pragma(runner, "foreign_keys")) === 1;
  const check = enforced || suspended.has(runner.owner);
  if (!enforced) return runner.transaction(() => rebuildSteps(runner, table, change, options, check));

  await runner.query(sql`pragma foreign_keys = off`);
  if ((await pragma(runner, "foreign_keys")) === 1) {
    // Inside a transaction: enforcement stays on, which is only safe when nothing references the table.
    const referencing = await referencingTables(runner, table);
    if (referencing.length) {
      throw new Error(
        `Tenora: changing SQLite table "${table}" rebuilds it, which needs foreign keys switched off, and SQLite does not allow that inside a transaction. Tables ${referencing.map((name) => `"${name}"`).join(", ")} reference it. Run the change outside a transaction, or start the transaction inside db.schema.withoutForeignKeyConstraints().`
      );
    }
    return runner.transaction(() => rebuildSteps(runner, table, change, options, check));
  }
  try {
    await runner.transaction(() => rebuildSteps(runner, table, change, options, check));
  } finally {
    await runner.query(sql`pragma foreign_keys = on`);
  }
};

const rebuildSteps = async (
  runner: SchemaRunner,
  table: string,
  change: (definition: TableDefinition) => TableDefinition,
  options: RebuildOptions,
  check: boolean
) => {
  const objects = await runner.query(
    sql`select type, name, sql from sqlite_schema where lower(tbl_name) = lower(${table}) and sql is not null`
  );
  const tableRow = objects.find((row) => row.type === "table");
  if (!tableRow) throw new Error(`Tenora: SQLite table "${table}" does not exist.`);
  const name = String(tableRow.name);
  const current = parseCreateTable(String(tableRow.sql));
  const info = await runner.query(sql`select name, hidden from pragma_table_xinfo(${name})`);
  if (
    info.length !== current.columns.length ||
    !info.every((row, index) => sameName(String(row.name), current.columns[index].name))
  ) {
    throw unreadable(`the columns of "${name}" do not match its pragmas`);
  }

  const next = change(current);
  if (!next.columns.length) throw new Error(`Tenora: SQLite table "${name}" would be left without columns.`);
  const dropped = options.dropped ?? [];
  const stored = new Set(info.filter((row) => Number(row.hidden) === 0).map((row) => String(row.name).toLowerCase()));
  const copied = next.columns
    .filter((column) => stored.has(column.name.toLowerCase()) && !hasName(dropped, column.name))
    .filter((column) => !column.clauses.some((clause) => clause.kind === "generated"))
    .map((column) => quoteIdentifier(column.name))
    .join(", ");

  const temporary = `__tenora_rebuild_${name}`;
  const body = [...next.columns.map((column) => column.text), ...next.constraints.map((constraint) => constraint.text)];
  const create = `CREATE TABLE ${quoteIdentifier(temporary)} (${body.join(", ")})${next.options ? ` ${next.options}` : ""}`;
  const run = (text: string) => runner.query(sql`${sql.raw(text)}`);

  await run(create);
  await run(`INSERT INTO ${quoteIdentifier(temporary)} (${copied}) SELECT ${copied} FROM ${quoteIdentifier(name)}`);
  await run(`DROP TABLE ${quoteIdentifier(name)}`);
  // Legacy renaming leaves triggers and views alone: they name the table, which exists again after the rename.
  const legacy = await pragma(runner, "legacy_alter_table");
  if (!legacy) await run("PRAGMA legacy_alter_table = ON");
  try {
    await run(`ALTER TABLE ${quoteIdentifier(temporary)} RENAME TO ${quoteIdentifier(name)}`);
  } finally {
    if (!legacy) await run("PRAGMA legacy_alter_table = OFF");
  }

  for (const row of objects) {
    const text = String(row.sql);
    if (row.type === "index") {
      const onDropped = indexColumns(text).some((column) => hasName(dropped, column));
      if (!onDropped) await run(text);
      else if (options.indexes === "shrink") {
        const shrunk = shrinkIndex(text, dropped);
        if (shrunk) await run(shrunk);
      }
    } else if (row.type === "trigger" && options.keepTriggers) {
      await run(text);
    }
  }

  if (check) {
    // Only the keys this rebuild can have broken: the table's own, and those that point at it.
    const violations: Row[] = [];
    for (const checked of new Set([name, ...(await referencingTables(runner, name))])) {
      violations.push(...(await runner.query(sql`select * from pragma_foreign_key_check(${checked})`)));
    }
    if (violations.length) {
      const [first] = violations;
      throw new Error(
        `Tenora: rebuilding SQLite table "${name}" broke ${violations.length} foreign key reference(s), for example row ${String(first.rowid)} of "${String(first.table)}" referencing "${String(first.parent)}". Nothing was changed.`
      );
    }
  }
};

/** What a column is used by, read from the pragmas: whether a plain DROP COLUMN can remove it. */
export const columnDependencies = async (runner: SchemaRunner, table: string, column: string) => {
  const info = await runner.query(sql`select name, pk from pragma_table_xinfo(${table})`);
  const primary = info.some((row) => sameName(String(row.name), column) && Number(row.pk) > 0);
  const indexes = await runner.query(
    sql`select l.name as name from pragma_index_list(${table}) as l, pragma_index_info(l.name) as i where lower(i.name) = lower(${column})`
  );
  const keys = await runner.query(
    sql`select "from", "table", "to" from pragma_foreign_key_list(${table})`
  );
  const foreign = keys.some(
    (row) => sameName(String(row.from), column) || (sameName(String(row.table), table) && sameName(String(row.to), column))
  );
  return { primary, indexed: indexes.length > 0, foreign };
};
