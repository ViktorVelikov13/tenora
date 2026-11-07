/**
 * The only module that uses Kysely. It turns Tenora's query state into SQL text and parameters through Kysely's
 * compile-only mode (a `Kysely<any>` with a `DummyDriver`); Kysely never runs a query. The dialect rules that Kysely
 * leaves to its caller (paging on SQL Server, RETURNING, empty IN lists, offsets without limits) are applied here.
 */
import {
  DummyDriver,
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
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql as kysql,
  type Expression,
  type ExpressionBuilder,
  type RawBuilder,
  type SqlBool,
} from "kysely";
import type { Dialect } from "./dialect";
import { RawSql, SqlIdentifier, SqlText } from "./sql";
import type { DeleteState, InsertState, QueryState, SelectState, UpdateState, Where } from "./query/state";

export type CompiledQuery = { readonly sql: string; readonly parameters: readonly unknown[] };

type Builder = ExpressionBuilder<any, any>;

const createCold = (dialect: Dialect): Kysely<any> => {
  const parts =
    dialect === "postgres"
      ? ([PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler] as const)
      : dialect === "sqlite"
        ? ([SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler] as const)
        : dialect === "mssql"
          ? ([MssqlAdapter, MssqlIntrospector, MssqlQueryCompiler] as const)
          : // MariaDB quotes and binds like MySQL; its differences are handled below.
            ([MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler] as const);
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

// Kysely's tag only reads the fragments as an array, so a plain array stands in for a TemplateStringsArray.
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

const condition = (eb: Builder, where: Where): Expression<SqlBool> => {
  switch (where.type) {
    case "basic":
      return eb(
        where.column,
        where.operator,
        where.value instanceof RawSql ? toKysely(where.value) : where.value
      );
    case "in":
      // "IN ()" is invalid SQL; an empty list matches nothing, and NOT IN an empty list matches everything.
      if (where.values.length === 0) return where.not ? kysql<SqlBool>`1 = 1` : kysql<SqlBool>`1 = 0`;
      return eb(where.column, where.not ? "not in" : "in", where.values);
    case "null":
      return eb(where.column, where.not ? "is not" : "is", null);
    case "nested":
      return conditions(eb, where.wheres);
    case "raw":
      return toKysely(where.sql) as RawBuilder<SqlBool>;
  }
};

/** Reads the flat list the way SQL precedence would: OR-separated groups of AND, as Eloquent emits it. */
const conditions = (eb: Builder, wheres: readonly Where[]): Expression<SqlBool> => {
  const groups: Expression<SqlBool>[][] = [];
  wheres.forEach((where, index) => {
    const expression = condition(eb, where);
    if (index === 0 || where.boolean === "or") groups.push([expression]);
    else groups[groups.length - 1].push(expression);
  });
  const ands = groups.map((group) => (group.length === 1 ? group[0] : eb.and(group)));
  return ands.length === 1 ? ands[0] : eb.or(ands);
};

// The largest LIMIT MySQL accepts, and SQLite's "no limit"; both need a LIMIT before an OFFSET.
const NO_LIMIT: Partial<Record<Dialect, RawBuilder<number>>> = {
  mysql: kysql<number>`18446744073709551615`,
  mariadb: kysql<number>`18446744073709551615`,
  sqlite: kysql<number>`-1`,
};

const compileSelect = (db: Kysely<any>, dialect: Dialect, state: SelectState): CompiledQuery => {
  let query = db.selectFrom(state.table);
  if (state.aggregate) {
    const { fn, column } = state.aggregate;
    query = query.select((eb) =>
      (column === "*" && fn === "count" ? eb.fn.countAll() : eb.fn(fn, [eb.ref(column)])).as("aggregate")
    );
  } else {
    query = state.columns.length ? query.select(state.columns as string[]) : query.selectAll();
  }
  if (state.distinct) query = query.distinct();
  if (state.wheres.length) query = query.where((eb) => conditions(eb, state.wheres));
  for (const order of state.orders) {
    const column = order.column instanceof RawSql ? toKysely(order.column) : order.column;
    query = query.orderBy(column, (ob) => (order.direction === "desc" ? ob.desc() : ob.asc()));
  }

  if (dialect === "mssql") {
    if (state.offset !== undefined) {
      // OFFSET ... FETCH needs an ORDER BY.
      if (!state.orders.length) query = query.orderBy(kysql`(select null)`);
      query = query.offset(state.offset);
      if (state.limit !== undefined) query = query.fetch(state.limit);
    } else if (state.limit !== undefined) {
      query = query.top(state.limit);
    }
  } else {
    if (state.limit !== undefined) query = query.limit(state.limit);
    else if (state.offset !== undefined && NO_LIMIT[dialect]) query = query.limit(NO_LIMIT[dialect]);
    if (state.offset !== undefined) query = query.offset(state.offset);
  }

  if (state.lock === "update") {
    if (dialect === "mssql") {
      throw new Error("Tenora: forUpdate() is not supported on SQL Server yet.");
    }
    // SQLite has no row locks; a transaction already holds the database lock, so this is a no-op there.
    if (dialect !== "sqlite") {
      query = query.forUpdate();
      if (state.skipLocked) query = query.skipLocked();
    }
  }
  return query.compile();
};

const compileInsert = (db: Kysely<any>, dialect: Dialect, state: InsertState): CompiledQuery => {
  const [first] = state.rows;
  if (!first) throw new Error("Tenora: insert() needs at least one row.");
  const columns = Object.keys(first).sort().join(",");
  for (const row of state.rows) {
    if (Object.keys(row).sort().join(",") !== columns) {
      throw new Error("Tenora: every row in one insert() must have the same columns.");
    }
  }
  const query = db.insertInto(state.table).values(state.rows as Record<string, unknown>[]);
  if (!state.returning?.length || dialect === "mysql") return query.compile();
  if (dialect === "mssql") {
    return query.output(state.returning.map((column) => `inserted.${column}`) as any).compile();
  }
  return query.returning(state.returning as string[]).compile();
};

const compileUpdate = (db: Kysely<any>, state: UpdateState): CompiledQuery => {
  const values = Object.fromEntries(
    Object.entries(state.values).map(([column, value]) => [
      column,
      value instanceof RawSql ? toKysely(value) : value,
    ])
  );
  if (!Object.keys(values).length) throw new Error("Tenora: update() needs at least one column.");
  let query = db.updateTable(state.table).set(values);
  if (state.wheres.length) query = query.where((eb) => conditions(eb, state.wheres));
  return query.compile();
};

const compileDelete = (db: Kysely<any>, state: DeleteState): CompiledQuery => {
  let query = db.deleteFrom(state.table);
  if (state.wheres.length) query = query.where((eb) => conditions(eb, state.wheres));
  return query.compile();
};

// Only the text and parameters leave this module; Kysely's syntax tree stays inside it.
const plain = ({ sql, parameters }: CompiledQuery): CompiledQuery => ({ sql, parameters });

export const compile = (dialect: Dialect, state: QueryState): CompiledQuery => {
  const db = coldFor(dialect);
  switch (state.kind) {
    case "select":
      return plain(compileSelect(db, dialect, state));
    case "insert":
      return plain(compileInsert(db, dialect, state));
    case "update":
      return plain(compileUpdate(db, state));
    case "delete":
      return plain(compileDelete(db, state));
  }
};

export const compileRaw = (dialect: Dialect, raw: RawSql): CompiledQuery =>
  plain(toKysely(raw).compile(coldFor(dialect)));
