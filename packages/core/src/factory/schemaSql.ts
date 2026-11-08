import { execFile } from "child_process";
import { type Connection, sql } from "@tenora/orm";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

type ConnectionSettings = Record<string, unknown>;

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

/**
 * `table` is where the migrator records which migrations ran; dumps keep the rows of that table and its lock table, and
 * no other data.
 */
export const dumpPostgres = async (
  connection: ConnectionSettings,
  database: string,
  table: string
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
  const structure = await runTool(command, [...common, "--schema-only"], env, "TENORA_PG_DUMP");
  const rows = await runTool(
    command,
    [
      ...common,
      "--data-only",
      "--inserts",
      `--table="${table}"`,
      `--table="${table}_lock"`,
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
  connection: ConnectionSettings,
  database: string,
  table: string
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
    [...common, "--no-create-info", "--skip-triggers", database, table, `${table}_lock`],
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

export const dumpSqlite = async (db: Connection, table: string): Promise<string> => {
  // Tables first, so views, indexes and triggers always find what they refer to.
  const objects = await db.raw<{ sql: string }>(
    sql`select sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by case type when 'table' then 0 when 'view' then 1 when 'index' then 2 else 3 end, rowid`
  );
  const statements = objects.map((object) => `${object.sql};`);
  for (const name of [table, `${table}_lock`]) {
    const rows = await db.raw(sql`select * from ${sql.ref(name)} order by rowid`);
    for (const row of rows) {
      const columns = Object.keys(row).map((column) => `"${column.replace(/"/g, '""')}"`);
      const values = Object.values(row).map(sqlLiteral);
      statements.push(`INSERT INTO "${name}" (${columns.join(", ")}) VALUES (${values.join(", ")});`);
    }
  }
  return statements.join("\n\n");
};

/** Loads a dump on a connection of its own, since Postgres dumps clear search_path for the rest of the session. */
export const loadSchemaSql = async (db: Connection, script: string) => {
  if (db.dialect === "postgres") {
    await db.script(script.split("\n").filter((line) => !line.startsWith("\\")).join("\n"));
  } else if (db.dialect === "sqlite") {
    // One transaction, as a migration has; otherwise SQLite syncs after every statement.
    await db.script(`BEGIN;\n${script}\nCOMMIT;`);
  } else {
    await db.script(script);
  }
};
