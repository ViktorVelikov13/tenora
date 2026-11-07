import fs from "node:fs";

const MSSQL_OPTIONS = { encrypt: false, trustServerCertificate: true };

const ADMIN_DATABASE = { postgres: "postgres", mysql: "mysql", mariadb: "mysql", mssql: "master" };
const CLIENT = { postgres: "pg", mysql: "mysql2", mariadb: "mariadb", mssql: "mssql" };

// Used by the harness to check results. Deliberately built without any Tenora code.
export const knexConfigFor = (id, server, database = ADMIN_DATABASE[id], credentials = {}) => {
  const { user = server.user, password = server.password } = credentials;
  const connection =
    id === "mssql"
      ? { server: server.host, port: server.port, user, password, database, options: MSSQL_OPTIONS }
      : { host: server.host, port: server.port, user, password, database };
  return { client: CLIENT[id], connection, pool: { min: 0, max: 2 }, acquireConnectionTimeout: 5_000 };
};

const sqliteEngine = (client) => ({
  id: client,
  label: `SQLite (${client})`,
  client,
  perTenantUsers: false,
  config: (project, baseDb) => ({
    base: { client, database: project.path("data", `${baseDb}.sqlite`) },
    tenant: { databaseDir: project.path("data") },
  }),
  locate: (project, name) => project.path("data", `${name}.sqlite`),
  knexConfig: (database) => ({
    client,
    useNullAsDefault: true,
    connection: { filename: database },
    pool: { min: 0, max: 1 },
  }),
  databaseExists: async (_admin, name) => fs.existsSync(name),
  createDatabase: async (_admin, name) => fs.writeFileSync(name, ""),
  cleanup: async () => {},
});

const serverEngine = (id, label, server, sql) => ({
  id,
  label: server ? `${label} (${server.source}): ${server.version}` : label,
  client: CLIENT[id],
  perTenantUsers: true,
  server,
  adminDatabase: ADMIN_DATABASE[id],
  createDatabase: (admin, name) => admin.raw(`create database ${name}`),
  config: (_project, baseDb) => ({
    base:
      id === "mssql"
        ? {
            client: CLIENT[id],
            database: baseDb,
            connection: {
              server: server.host,
              port: server.port,
              user: server.user,
              password: server.password,
              options: MSSQL_OPTIONS,
            },
          }
        : {
            client: CLIENT[id],
            host: server.host,
            port: server.port,
            user: server.user,
            password: server.password,
            database: baseDb,
          },
    tenant: {},
  }),
  locate: (_project, name) => name,
  knexConfig: (database, credentials) => knexConfigFor(id, server, database, credentials),
  ...sql,
});

const firstRows = (result) => result?.rows ?? (Array.isArray(result?.[0]) ? result[0] : result);

const postgresSql = {
  databaseExists: async (admin, name) =>
    firstRows(await admin.raw("select 1 from pg_database where datname = ?", [name])).length > 0,
  userExists: async (admin, name) =>
    firstRows(await admin.raw("select 1 from pg_roles where rolname = ?", [name])).length > 0,
  currentUser: async (db) => firstRows(await db.raw("select current_user as name"))[0].name,
  cleanup: async (admin, { databases, users }) => {
    for (const name of databases) {
      await admin.raw(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = ? and pid <> pg_backend_pid()",
        [name]
      );
      await admin.raw(`drop database if exists "${name}"`);
    }
    for (const name of users) {
      await admin.raw(`drop role if exists "${name}"`);
    }
  },
};

const mysqlSql = {
  databaseExists: async (admin, name) =>
    firstRows(
      await admin.raw("select 1 from information_schema.schemata where schema_name = ?", [name])
    ).length > 0,
  userExists: async (admin, name) =>
    firstRows(await admin.raw("select 1 from mysql.user where user = ?", [name])).length > 0,
  currentUser: async (db) =>
    firstRows(await db.raw("select substring_index(current_user(), '@', 1) as name"))[0].name,
  cleanup: async (admin, { databases, users }) => {
    for (const name of databases) {
      await admin.raw(`drop database if exists \`${name}\``);
    }
    for (const name of users) {
      await admin.raw(`drop user if exists '${name}'@'%'`);
    }
  },
};

const mssqlSql = {
  databaseExists: async (admin, name) =>
    firstRows(await admin.raw("select name from sys.databases where name = ?", [name])).length > 0,
  userExists: async (admin, name) =>
    firstRows(await admin.raw("select name from sys.server_principals where name = ?", [name]))
      .length > 0,
  currentUser: async (db) => firstRows(await db.raw("select suser_sname() as name"))[0].name,
  cleanup: async (admin, { databases, users }) => {
    for (const name of databases) {
      await admin.raw(
        `if db_id(N'${name}') is not null begin alter database [${name}] set single_user with rollback immediate; drop database [${name}]; end`
      );
    }
    for (const name of users) {
      await admin.raw(`if suser_id(N'${name}') is not null drop login [${name}]`);
    }
  },
};

export const loadEngines = () => {
  const { servers = {}, skipped = {} } = JSON.parse(process.env.TENORA_TEST_SERVERS ?? "{}");
  const entries = [
    ["postgres", "Postgres", postgresSql],
    ["mysql", "MySQL", mysqlSql],
    ["mariadb", "MariaDB", mysqlSql],
    ["mssql", "SQL Server", mssqlSql],
  ];
  return [
    sqliteEngine("sqlite3"),
    sqliteEngine("better-sqlite3"),
    ...entries.map(([id, label, sql]) => ({
      ...serverEngine(id, label, servers[id], sql),
      skip: servers[id] ? false : `no ${label} server: ${skipped[id] ?? "not configured"}`,
    })),
  ];
};
