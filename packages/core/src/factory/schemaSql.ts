import { execFile } from "child_process";
import type { Knex } from "knex";
import { promisify } from "util";
import type { TenoraClient } from "../types";
import { isMysqlClient, isPostgresClient, isSqliteClient } from "./shared";

const execFileAsync = promisify(execFile);

/** Where Knex records which migrations ran; dumps keep these rows and no other data. */
export type MigrationTables = { tableName: string; schemaName?: string };

type Connection = Record<string, unknown>;
type DriverConnection = {
  query: (sql: string, callback?: (error: Error | null) => void) => Promise<unknown> | void;
  exec: (sql: string, callback?: (error: Error | null) => void) => void;
};
type KnexClient = {
  acquireConnection: () => Promise<DriverConnection>;
  releaseConnection: (connection: DriverConnection) => Promise<void>;
};

const runTool = async (command: string, args: string[], env: NodeJS.ProcessEnv, override: string) => {
  try {
    const { stdout } = await execFileAsync(command, args, {
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === "ENOENT") {
      throw new Error(`Tenora: schema dumps need "${command}". Install it, or set ${override} to its path.`);
    }
    throw new Error(`Tenora: ${command} failed: ${(failure.stderr || failure.message).trim()}`);
  }
};

// pg_dump's own comments carry its version, and its \restrict lines only make sense to psql.
const cleanPostgresDump = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.startsWith("\\") && !line.startsWith("--"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const dumpPostgres = async (
  connection: Connection,
  database: string,
  tables: MigrationTables
): Promise<string> => {
  const command = process.env.TENORA_PG_DUMP || "pg_dump";
  const env: NodeJS.ProcessEnv = {};
  const target: string[] = [];
  if (typeof connection.connectionString === "string") {
    const url = new URL(connection.connectionString);
    url.pathname = `/${encodeURIComponent(database)}`;
    target.push(`--dbname=${url}`);
  } else {
    if (connection.host) target.push(`--host=${connection.host}`);
    if (connection.port) target.push(`--port=${connection.port}`);
    if (connection.user) target.push(`--username=${connection.user}`);
    target.push(`--dbname=${database}`);
  }
  if (connection.password !== undefined) env.PGPASSWORD = String(connection.password);
  if (connection.ssl) env.PGSSLMODE = "require";

  const common = [...target, "--no-owner", "--no-privileges"];
  const qualify = (name: string) => `${tables.schemaName ? `"${tables.schemaName}".` : ""}"${name}"`;
  const structure = await runTool(command, [...common, "--schema-only"], env, "TENORA_PG_DUMP");
  const rows = await runTool(
    command,
    [
      ...common,
      "--data-only",
      "--inserts",
      `--table=${qualify(tables.tableName)}`,
      `--table=${qualify(`${tables.tableName}_lock`)}`,
    ],
    env,
    "TENORA_PG_DUMP"
  );
  return `${cleanPostgresDump(structure)}\n\n${cleanPostgresDump(rows)}`;
};

// AUTO_INCREMENT counters are data, and a DEFINER would need privileges the tenant user lacks.
const cleanMysqlDump = (sql: string) =>
  sql
    .replace(/ AUTO_INCREMENT=\d+/g, "")
    .replace(/DEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*`\s*/g, "")
    .trim();

const findMysqlDump = async (dialect: "mysql" | "mariadb") => {
  const override = dialect === "mariadb" ? "TENORA_MARIADB_DUMP" : "TENORA_MYSQLDUMP";
  const configured =
    dialect === "mariadb"
      ? process.env.TENORA_MARIADB_DUMP || process.env.TENORA_MYSQLDUMP
      : process.env.TENORA_MYSQLDUMP;
  const candidates = configured
    ? [configured]
    : dialect === "mariadb"
      ? ["mariadb-dump", "mysqldump"]
      : ["mysqldump", "mariadb-dump"];
  for (const command of candidates) {
    try {
      return { command, override, version: await runTool(command, ["--version"], {}, override) };
    } catch (error) {
      if (configured || !(error as Error).message.includes("schema dumps need")) throw error;
    }
  }
  throw new Error(
    `Tenora: schema dumps need mysqldump or mariadb-dump. Install one, or set ${override} to its path.`
  );
};

export const dumpMysql = async (
  dialect: "mysql" | "mariadb",
  connection: Connection,
  database: string,
  tables: MigrationTables
): Promise<string> => {
  const { command, override, version } = await findMysqlDump(dialect);
  const env: NodeJS.ProcessEnv = {};
  const common: string[] = [];
  if (connection.socketPath) {
    common.push(`--socket=${connection.socketPath}`);
  } else {
    if (connection.host) common.push(`--host=${connection.host}`);
    if (connection.port) common.push(`--port=${connection.port}`);
  }
  if (connection.user) common.push(`--user=${connection.user}`);
  if (connection.password !== undefined) env.MYSQL_PWD = String(connection.password);
  // Oracle's mysqldump writes GTID statements that need extra privileges, and asks MariaDB for
  // column statistics it does not have.
  if (!version.includes("MariaDB")) {
    common.push("--set-gtid-purged=OFF");
    if (dialect === "mariadb") common.push("--column-statistics=0");
  }
  common.push("--compact", "--no-tablespaces", "--single-transaction");

  const structure = await runTool(
    command,
    [...common, "--no-data", "--routines", "--triggers", database],
    env,
    override
  );
  const rows = await runTool(
    command,
    [...common, "--no-create-info", "--skip-triggers", database, tables.tableName, `${tables.tableName}_lock`],
    env,
    override
  );
  return `${cleanMysqlDump(structure)}\n\n${rows.trim()}`;
};

const sqlLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  if (value instanceof Date) return `'${value.toISOString()}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
};

export const dumpSqlite = async (db: Knex, tables: MigrationTables): Promise<string> => {
  // Tables first, so views, indexes and triggers always find what they refer to.
  const objects: { sql: string }[] = await db
    .select("sql")
    .from("sqlite_master")
    .whereNotNull("sql")
    .andWhereNot("name", "like", "sqlite_%")
    .orderByRaw(
      "CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, rowid"
    );
  const statements = objects.map(({ sql }) => `${sql};`);
  for (const table of [tables.tableName, `${tables.tableName}_lock`]) {
    const rows: Record<string, unknown>[] = await db(table).select("*").orderByRaw("rowid");
    for (const row of rows) {
      const columns = Object.keys(row).map((column) => `"${column.replace(/"/g, '""')}"`);
      const values = Object.values(row).map(sqlLiteral);
      statements.push(`INSERT INTO "${table}" (${columns.join(", ")}) VALUES (${values.join(", ")});`);
    }
  }
  return statements.join("\n\n");
};

/**
 * Splits a mysqldump script into statements. Drivers run one statement at a time, and DELIMITER
 * is a mysql client command rather than SQL, so it is handled here.
 */
export const splitMysqlStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let delimiter = ";";
  let buffer: string[] = [];
  const flush = () => {
    const statement = buffer.join("\n").trim();
    buffer = [];
    const onlyComments = statement
      .split("\n")
      .every((line) => !line.trim() || line.trim().startsWith("--"));
    if (!onlyComments) statements.push(statement);
  };
  for (const line of sql.split("\n")) {
    const change = /^DELIMITER\s+(\S+)$/i.exec(line.trim());
    if (change) {
      flush();
      delimiter = change[1];
      continue;
    }
    const trimmed = line.trimEnd();
    if (trimmed.endsWith(delimiter)) {
      buffer.push(trimmed.slice(0, -delimiter.length));
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return statements;
};

/** Runs a dump through the driver's own connection, which accepts whole scripts where Knex does not. */
export const loadSchemaSql = async (db: Knex, client: TenoraClient, sql: string) => {
  const knexClient = (db as unknown as { client: KnexClient }).client;
  const connection = await knexClient.acquireConnection();
  const callback = (run: (done: (error: Error | null) => void) => void) =>
    new Promise<void>((resolve, reject) => run((error) => (error ? reject(error) : resolve())));
  try {
    if (isPostgresClient(client)) {
      await connection.query(sql.split("\n").filter((line) => !line.startsWith("\\")).join("\n"));
    } else if (isMysqlClient(client)) {
      // One round trip; the caller opens this connection with multipleStatements.
      const script = splitMysqlStatements(sql).join(";\n");
      await callback((done) => connection.query(script, done));
    } else if (isSqliteClient(client)) {
      // One transaction, as Knex uses for a migration batch; otherwise SQLite syncs after every statement.
      const script = `BEGIN;\n${sql}\nCOMMIT;`;
      if (client === "better-sqlite3") {
        connection.exec(script);
      } else {
        await callback((done) => connection.exec(script, done));
      }
    } else {
      throw new Error(`Tenora: schema dumps are not supported for the "${client}" client.`);
    }
  } finally {
    await knexClient.releaseConnection(connection);
  }
};
