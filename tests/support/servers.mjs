import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import knex from "knex";
import { knexConfigFor } from "./engines.mjs";

const HOST = "127.0.0.1";
const LOCAL_PASSWORD = "tenora_test_pw";

const URL_ENV = {
  postgres: "TENORA_TEST_PG_URL",
  mysql: "TENORA_TEST_MYSQL_URL",
  mariadb: "TENORA_TEST_MARIADB_URL",
  mssql: "TENORA_TEST_MSSQL_URL",
};

const VERSION_SQL = {
  postgres: "select version() as version",
  mysql: "select version() as version",
  mariadb: "select version() as version",
  mssql: "select @@version as version",
};

const hasCommand = (command) => spawnSync("which", [command]).status === 0;

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const fromUrl = (url) => {
  const parsed = new URL(url);
  return {
    source: "url",
    host: parsed.hostname,
    port: Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
};

// Trust auth would accept any password, so the tenant credential tests would prove nothing.
const startLocalPostgres = async (root) => {
  if (!hasCommand("initdb") || !hasCommand("pg_ctl")) return undefined;
  const dataDir = path.join(root, "postgres");
  const passwordFile = path.join(root, "postgres.pw");
  const port = await freePort();
  fs.writeFileSync(passwordFile, LOCAL_PASSWORD);
  run("initdb", ["-D", dataDir, "-U", "postgres", `--pwfile=${passwordFile}`, "--auth=scram-sha-256"]);
  run("pg_ctl", [
    "-D",
    dataDir,
    "-l",
    path.join(root, "postgres.log"),
    "-w",
    "-o",
    `-p ${port} -c listen_addresses=${HOST} -c unix_socket_directories=''`,
    "start",
  ]);
  return {
    source: "temporary",
    host: HOST,
    port,
    user: "postgres",
    password: LOCAL_PASSWORD,
    stop: async () => run("pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"]),
  };
};

const startLocalMysql = async (root) => {
  if (!hasCommand("mysqld")) return undefined;
  if (run("mysqld", ["--version"]).includes("MariaDB")) return undefined;
  const dataDir = path.join(root, "mysql");
  const port = await freePort();
  run("mysqld", ["--no-defaults", "--initialize-insecure", `--datadir=${dataDir}`]);
  const child = spawn(
    "mysqld",
    [
      "--no-defaults",
      `--datadir=${dataDir}`,
      `--port=${port}`,
      `--bind-address=${HOST}`,
      `--socket=${path.join(root, "mysql.sock")}`,
      `--pid-file=${path.join(root, "mysql.pid")}`,
      "--mysqlx=OFF",
    ],
    { stdio: "ignore" }
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return {
    source: "temporary",
    host: HOST,
    port,
    user: "root",
    password: "",
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
    },
  };
};

const readVersion = async (id, server) => {
  const client = knex({ ...knexConfigFor(id, server), acquireConnectionTimeout: 3_000 });
  try {
    const result = await client.raw(VERSION_SQL[id]);
    const rows = result?.rows ?? (Array.isArray(result?.[0]) ? result[0] : result);
    return String(rows[0].version).split("\n")[0];
  } finally {
    await client.destroy();
  }
};

const waitForVersion = async (id, server, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readVersion(id, server);
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`${id} at ${server.host}:${server.port} is not reachable: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
};

/**
 * A server is taken from its TENORA_TEST_*_URL when set (and must then be reachable),
 * otherwise started as a throwaway instance from local binaries, otherwise left out.
 */
export const startServers = async (root) => {
  const local = { postgres: startLocalPostgres, mysql: startLocalMysql };
  const servers = {};
  const skipped = {};

  const stop = async () => {
    for (const server of Object.values(servers)) {
      await server.stop?.().catch((error) => console.error(error.message));
    }
  };

  try {
    for (const [id, envName] of Object.entries(URL_ENV)) {
      const url = process.env[envName];
      const server = url ? fromUrl(url) : await local[id]?.(root);
      if (!server) {
        skipped[id] = `set ${envName} or run "npm run test:docker"`;
        continue;
      }
      servers[id] = server;
      server.version = await waitForVersion(id, server);
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return { servers, skipped, stop };
};
