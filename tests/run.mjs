#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./support/project.mjs";
import { startServers } from "./support/servers.mjs";

const COMPOSE_FILE = path.join(repoRoot, "tests/docker-compose.yml");

/** A port nothing listens on right now, so several test runs can each publish their own databases. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const args = process.argv.slice(2);
const useDocker = args.includes("--docker");
const testFiles = args.filter((arg) => arg !== "--docker");

const compose = (...composeArgs) =>
  spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...composeArgs], { stdio: "inherit" }).status;

if (useDocker) {
  // Each run gets its own compose project and ports, so runs in parallel (several worktrees) cannot stop or reuse each
  // other's databases. CI sets COMPOSE_PROJECT_NAME so its log step can find the containers. The dump helpers inherit
  // both through the environment.
  process.env.COMPOSE_PROJECT_NAME ??= `tenora-test-${randomBytes(3).toString("hex")}`;
  const ports = {
    TENORA_TEST_PG_PORT: await freePort(),
    TENORA_TEST_MYSQL_PORT: await freePort(),
    TENORA_TEST_MARIADB_PORT: await freePort(),
    TENORA_TEST_MSSQL_PORT: await freePort(),
  };
  Object.assign(process.env, Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, String(port)])));

  // SQL Server's container sometimes crashes while it sets itself up (seen on GitHub's Ubuntu 26.04 runners, errno 11
  // inside its security subsystem). Its files may be half-written by then, so every container starts over once.
  if (compose("up", "-d", "--wait") !== 0) {
    console.warn("\nA database container failed to start. Removing the containers and starting them once more.\n");
    compose("down", "-v");
    if (compose("up", "-d", "--wait") !== 0) process.exit(1);
  }
  Object.assign(process.env, {
    TENORA_TEST_PG_URL: `postgres://postgres:Tenora_test_pw1@127.0.0.1:${ports.TENORA_TEST_PG_PORT}`,
    TENORA_TEST_MYSQL_URL: `mysql://root:Tenora_test_pw1@127.0.0.1:${ports.TENORA_TEST_MYSQL_PORT}`,
    TENORA_TEST_MARIADB_URL: `mariadb://root:Tenora_test_pw1@127.0.0.1:${ports.TENORA_TEST_MARIADB_PORT}`,
    TENORA_TEST_MSSQL_URL: `mssql://sa:Tenora_test_pw1@127.0.0.1:${ports.TENORA_TEST_MSSQL_PORT}`,
  });
  // Dump tools must be at least as new as the server, so run the ones inside each container.
  const inContainer = (tool) => path.join(repoRoot, "tests/support/docker-dump", `${tool}.mjs`);
  process.env.TENORA_PG_DUMP ??= inContainer("pg_dump");
  process.env.TENORA_MYSQLDUMP ??= inContainer("mysqldump");
  process.env.TENORA_MARIADB_DUMP ??= inContainer("mariadb-dump");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tenora-db-"));
let started;

const cleanUp = async () => {
  await started?.stop();
  started = undefined;
  fs.rmSync(root, { recursive: true, force: true });
  if (useDocker) compose("down", "-v");
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => cleanUp().finally(() => process.exit(1)));
}

let status = 1;
try {
  started = await startServers(root);
  const { servers, skipped } = started;

  console.log("\nDatabases under test:");
  console.log("  SQLite: sqlite3 and better-sqlite3 (always)");
  for (const [id, server] of Object.entries(servers)) {
    console.log(`  ${id}: ${server.version} [${server.source}]`);
  }
  for (const [id, reason] of Object.entries(skipped)) {
    console.log(`  ${id}: SKIPPED (${reason})`);
  }
  console.log("");

  const child = spawn(
    process.execPath,
    ["--test", "--test-concurrency=1", ...(testFiles.length ? testFiles : ["tests/*.test.mjs"])],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, TENORA_TEST_SERVERS: JSON.stringify({ servers, skipped }) },
    }
  );
  const [code] = await once(child, "exit");
  status = code ?? 1;
} finally {
  await cleanUp();
}

process.exit(status);
