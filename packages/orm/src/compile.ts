/**
 * The only module that uses Kysely. It turns Tenora's query state into SQL text and parameters through Kysely's
 * compile-only mode (a `Kysely<any>` with a `DummyDriver`); Kysely never runs a query. The dialect rules that Kysely
 * leaves to its caller (paging and locks on SQL Server, RETURNING, upserts, empty IN lists, offsets without limits)
 * are applied here.
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
  type SelectQueryBuilder,
  type SqlBool,
} from "kysely";
import type { Dialect } from "./dialect";
import { RawSql, SqlIdentifier, SqlText } from "./sql";
import {
  type DeleteState,
  type InsertState,
  type QueryState,
  type SelectState,
  type Source,
  SubQuery,
  type UpdateState,
  type UpsertState,
  type Where,
} from "./query/state";

export type CompiledQuery = { readonly sql: string; readonly parameters: readonly unknown[] };

type Builder = ExpressionBuilder<any, any>;
type Select = SelectQueryBuilder<any, any, any>;
type Context = { db: Kysely<any>; dialect: Dialect };

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

/** A comparison operand: a bound value, a raw fragment, or a subquery. */
const operand = (context: Context, value: unknown) =>
  value instanceof RawSql
    ? toKysely(value)
    : value instanceof SubQuery
      ? buildSelect(context, value.state)
      : value;

const condition = (context: Context, eb: Builder, where: Where): Expression<SqlBool> => {
  switch (where.type) {
    case "basic":
      return eb(where.column, where.operator, operand(context, where.value));
    case "column":
      return eb(eb.ref(where.first), where.operator, eb.ref(where.second));
    case "in": {
      const operator = where.not ? "not in" : "in";
      if (where.values instanceof SubQuery) return eb(where.column, operator, buildSelect(context, where.values.state));
      // "IN ()" is invalid SQL; an empty list matches nothing, and NOT IN an empty list matches everything.
      if (where.values.length === 0) return where.not ? kysql<SqlBool>`1 = 1` : kysql<SqlBool>`1 = 0`;
      return eb(where.column, operator, where.values);
    }
    case "null":
      return eb(where.column, where.not ? "is not" : "is", null);
    case "between": {
      const between = eb.between(eb.ref(where.column), where.low, where.high);
      return where.not ? eb.not(between) : between;
    }
    case "exists": {
      const exists = eb.exists(buildSelect(context, where.query));
      return where.not ? eb.not(exists) : exists;
    }
    case "nested":
      return conditions(context, eb, where.wheres);
    case "raw":
      return toKysely(where.sql) as RawBuilder<SqlBool>;
  }
};

/** Reads the flat list the way SQL precedence would: OR-separated groups of AND, as Eloquent emits it. */
const conditions = (context: Context, eb: Builder, wheres: readonly Where[]): Expression<SqlBool> => {
  const groups: Expression<SqlBool>[][] = [];
  wheres.forEach((where, index) => {
    const expression = condition(context, eb, where);
    if (index === 0 || where.boolean === "or") groups.push([expression]);
    else groups[groups.length - 1].push(expression);
  });
  const ands = groups.map((group) => (group.length === 1 ? group[0] : eb.and(group)));
  return ands.length === 1 ? ands[0] : eb.or(ands);
};

const ALIAS = /^(.+?)\s+as\s+(.+)$/i;

/** SQL Server takes locks as table hints, after the table and its alias: `from "jobs" as "j" with (updlock)`. */
const lockedTable = (name: string, hints: string) => {
  const match = ALIAS.exec(name.trim());
  const table = match
    ? kysql`${kysql.table(match[1])} as ${kysql.id(match[2])}`
    : kysql`${kysql.table(name.trim())}`;
  return kysql`${table} with (${kysql.raw(hints)})`;
};

const MSSQL_HINTS = {
  update: (skipLocked: boolean) => (skipLocked ? "updlock, rowlock, readpast" : "updlock, rowlock"),
  share: (skipLocked: boolean) => (skipLocked ? "holdlock, rowlock, readpast" : "holdlock, rowlock"),
};

const sourceOf = (context: Context, source: Source) =>
  source.type === "table" ? source.name : buildSelect(context, source.query).as(source.alias);

// The largest LIMIT MySQL accepts, and SQLite's "no limit"; both need a LIMIT before an OFFSET.
const NO_LIMIT: Partial<Record<Dialect, RawBuilder<number>>> = {
  mysql: kysql<number>`18446744073709551615`,
  mariadb: kysql<number>`18446744073709551615`,
  sqlite: kysql<number>`-1`,
};

const RANDOM: Record<Dialect, RawBuilder<unknown>> = {
  postgres: kysql`random()`,
  sqlite: kysql`random()`,
  mysql: kysql`rand()`,
  mariadb: kysql`rand()`,
  mssql: kysql`newid()`,
};

const assertUnionPart = (part: SelectState) => {
  if (part.orders.length || part.limit !== undefined || part.offset !== undefined) {
    throw new Error("Tenora: a query passed to union() cannot have orderBy, limit or offset; put them on the outer query.");
  }
};

const buildSelect = (context: Context, state: SelectState): Select => {
  const { db, dialect } = context;
  const { from } = state;
  let query: Select =
    dialect === "mssql" && state.lock && from.type === "table"
      ? db.selectFrom(lockedTable(from.name, MSSQL_HINTS[state.lock](state.skipLocked)) as any)
      : db.selectFrom(sourceOf(context, from) as any);

  for (const join of state.joins) {
    const target = sourceOf(context, join.source) as any;
    if (join.type === "cross") {
      query = query.crossJoin(target);
      continue;
    }
    if (!join.conditions.length) throw new Error("Tenora: a join needs at least one condition.");
    const on = (builder: any) => builder.on((eb: Builder) => conditions(context, eb, join.conditions));
    query =
      join.type === "left"
        ? query.leftJoin(target, on)
        : join.type === "right"
          ? query.rightJoin(target, on)
          : query.innerJoin(target, on);
  }

  if (state.aggregate) {
    const { fn, column } = state.aggregate;
    query = query.select((eb) =>
      (column === "*" && fn === "count" ? eb.fn.countAll() : eb.fn(fn, [eb.ref(column)])).as("aggregate")
    );
  } else if (state.columns.length) {
    query = query.select(
      state.columns.map((selection) =>
        selection.type === "column"
          ? selection.name
          : selection.type === "raw"
            ? (toKysely(selection.sql) as any)
            : buildSelect(context, selection.query).as(selection.alias)
      )
    );
  } else {
    query = query.selectAll();
  }

  if (state.distinct) query = query.distinct();
  if (state.wheres.length) query = query.where((eb) => conditions(context, eb, state.wheres));
  if (state.groups.length) query = query.groupBy(state.groups as string[]);
  if (state.havings.length) query = query.having((eb) => conditions(context, eb, state.havings));

  for (const { query: part, all } of state.unions) {
    assertUnionPart(part);
    const built = buildSelect(context, part);
    query = all ? query.unionAll(built) : query.union(built);
  }

  // ORDER BY, LIMIT and OFFSET come after any UNION, so they apply to the whole result.
  for (const order of state.orders) {
    if (order.type === "random") query = query.orderBy(RANDOM[dialect]);
    else if (order.type === "raw") query = query.orderBy(toKysely(order.sql));
    else query = query.orderBy(order.column, (ob) => (order.direction === "desc" ? ob.desc() : ob.asc()));
  }

  if (dialect === "mssql") {
    // TOP would only limit the first part of a UNION, so a union pages with OFFSET ... FETCH too.
    if (state.offset !== undefined || (state.limit !== undefined && state.unions.length)) {
      // OFFSET ... FETCH needs an ORDER BY.
      if (!state.orders.length) query = query.orderBy(kysql`(select null)`);
      query = query.offset(state.offset ?? 0);
      if (state.limit !== undefined) query = query.fetch(state.limit);
    } else if (state.limit !== undefined) {
      query = query.top(state.limit);
    }
  } else {
    if (state.limit !== undefined) query = query.limit(state.limit);
    else if (state.offset !== undefined && NO_LIMIT[dialect]) query = query.limit(NO_LIMIT[dialect]);
    if (state.offset !== undefined) query = query.offset(state.offset);
  }

  // SQLite has no row locks (a transaction already locks the database), and SQL Server's are table hints above.
  if (state.lock && dialect !== "sqlite" && dialect !== "mssql") {
    if (state.lock === "update") query = query.forUpdate();
    else if (dialect === "mariadb") query = query.modifyEnd(kysql`lock in share mode`);
    else query = query.forShare();
    if (state.skipLocked) query = query.skipLocked();
  }
  return query;
};

/**
 * A count over a grouped, distinct or unioned query counts its rows from a subquery; counting it directly would
 * return the count of the first group only.
 */
const buildAggregate = (context: Context, state: SelectState): Select => {
  const { fn } = state.aggregate!;
  const grouped = state.groups.length || state.havings.length || state.distinct || state.unions.length;
  if (!grouped) return buildSelect(context, state);
  if (fn !== "count") {
    throw new Error(
      `Tenora: ${fn}() cannot run on a grouped, distinct or unioned query; select it with selectRaw() and groupBy() instead.`
    );
  }
  const inner = buildSelect(context, { ...state, aggregate: undefined });
  return context.db.selectFrom(inner.as("tenora_count")).select((eb) => eb.fn.countAll().as("aggregate"));
};

const assertSameColumns = (rows: readonly Record<string, unknown>[], action: string) => {
  const [first] = rows;
  if (!first) throw new Error(`Tenora: ${action}() needs at least one row.`);
  const columns = Object.keys(first).sort().join(",");
  for (const row of rows) {
    if (Object.keys(row).sort().join(",") !== columns) {
      throw new Error(`Tenora: every row in one ${action}() must have the same columns.`);
    }
  }
  return Object.keys(first);
};

const compileInsert = ({ db, dialect }: Context, state: InsertState) => {
  assertSameColumns(state.rows, "insert");
  const query = db.insertInto(state.table).values(state.rows as Record<string, unknown>[]);
  if (!state.returning?.length || dialect === "mysql") return query.compile();
  if (dialect === "mssql") {
    return query.output(state.returning.map((column) => `inserted.${column}`) as any).compile();
  }
  return query.returning(state.returning as string[]).compile();
};

const compileUpsert = ({ db, dialect }: Context, state: UpsertState) => {
  const columns = assertSameColumns(state.rows, "upsert");
  const { table, rows, uniqueBy, update } = state;
  if (!uniqueBy.length) throw new Error("Tenora: upsert() needs the columns of a unique key in uniqueBy.");
  for (const column of [...uniqueBy, ...update]) {
    if (!columns.includes(column)) throw new Error(`Tenora: upsert() rows have no "${column}" column.`);
  }
  const insert = () => db.insertInto(table).values(rows as Record<string, unknown>[]);

  switch (dialect) {
    case "postgres":
    case "sqlite":
      return insert()
        .onConflict((conflict) => {
          const target = conflict.columns(uniqueBy as string[]);
          return update.length
            ? target.doUpdateSet(
                Object.fromEntries(update.map((column) => [column, (eb: Builder) => eb.ref(`excluded.${column}`)]))
              )
            : target.doNothing();
        })
        .compile();
    case "mysql":
      // MySQL deprecates VALUES() here in favour of a row alias, which has to follow the VALUES list.
      return insert()
        .modifyEnd(
          update.length
            ? kysql`as ${kysql.id("tenora_new")} on duplicate key update ${kysql.join(
                update.map((column) => kysql`${kysql.ref(column)} = ${kysql.ref(`tenora_new.${column}`)}`)
              )}`
            : // A no-op update leaves the row alone without INSERT IGNORE, which would hide every other error too.
              kysql`on duplicate key update ${kysql.ref(uniqueBy[0])} = ${kysql.ref(uniqueBy[0])}`
        )
        .compile();
    case "mariadb":
      // MariaDB has no row alias; VALUES() is its way to read the new row.
      return insert()
        .onDuplicateKeyUpdate(
          Object.fromEntries(
            update.length
              ? update.map((column) => [column, kysql`values(${kysql.ref(column)})`])
              : [[uniqueBy[0], kysql`${kysql.ref(uniqueBy[0])}`]]
          )
        )
        .compile();
    case "mssql": {
      // MERGE, with HOLDLOCK so two upserts of the same new key cannot both insert it.
      const names = kysql.join(columns.map((column) => kysql.id(column)));
      const source = (column: string) => kysql.ref(`tenora_source.${column}`);
      const values = kysql.join(rows.map((row) => kysql`(${kysql.join(columns.map((column) => row[column]))})`));
      const matches = kysql.join(
        uniqueBy.map((column) => kysql`${kysql.ref(`tenora_target.${column}`)} = ${source(column)}`),
        kysql` and `
      );
      const whenMatched = update.length
        ? kysql`when matched then update set ${kysql.join(
            update.map((column) => kysql`${kysql.ref(column)} = ${source(column)}`)
          )} `
        : kysql``;
      return kysql`merge into ${kysql.table(table)} with (holdlock) as ${kysql.id("tenora_target")} using (values ${values}) as ${kysql.id(
        "tenora_source"
      )} (${names}) on ${matches} ${whenMatched}when not matched then insert (${names}) values (${kysql.join(
        columns.map(source)
      )});`.compile(db);
    }
  }
};

const compileUpdate = (context: Context, state: UpdateState) => {
  const values = Object.fromEntries(
    Object.entries(state.values).map(([column, value]) => [column, operand(context, value)])
  );
  if (!Object.keys(values).length) throw new Error("Tenora: update() needs at least one column.");
  let query = context.db.updateTable(state.table).set(values);
  if (state.wheres.length) query = query.where((eb) => conditions(context, eb, state.wheres));
  return query.compile();
};

const compileDelete = (context: Context, state: DeleteState) => {
  let query = context.db.deleteFrom(state.table);
  if (state.wheres.length) query = query.where((eb) => conditions(context, eb, state.wheres));
  return query.compile();
};

// Only the text and parameters leave this module; Kysely's syntax tree stays inside it.
const plain = ({ sql, parameters }: CompiledQuery): CompiledQuery => ({ sql, parameters });

export const compile = (dialect: Dialect, state: QueryState): CompiledQuery => {
  const context: Context = { db: coldFor(dialect), dialect };
  switch (state.kind) {
    case "select":
      return plain((state.aggregate ? buildAggregate(context, state) : buildSelect(context, state)).compile());
    case "insert":
      return plain(compileInsert(context, state));
    case "upsert":
      return plain(compileUpsert(context, state));
    case "update":
      return plain(compileUpdate(context, state));
    case "delete":
      return plain(compileDelete(context, state));
  }
};

export const compileRaw = (dialect: Dialect, raw: RawSql): CompiledQuery =>
  plain(toKysely(raw).compile(coldFor(dialect)));
