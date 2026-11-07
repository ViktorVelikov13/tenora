#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "./support/project.mjs";
import { startServers } from "./support/servers.mjs";

const COMPOSE_FILE = path.join(repoRoot, "tests/docker-compose.yml");
const DOCKER_URLS = {
  TENORA_TEST_PG_URL: "postgres://postgres:Tenora_test_pw1@127.0.0.1:56432",
  TENORA_TEST_MYSQL_URL: "mysql://root:Tenora_test_pw1@127.0.0.1:56306",
  TENORA_TEST_MARIADB_URL: "mariadb://root:Tenora_test_pw1@127.0.0.1:56307",
  TENORA_TEST_MSSQL_URL: "mssql://sa:Tenora_test_pw1@127.0.0.1:56433",
};

const args = process.argv.slice(2);
const useDocker = args.includes("--docker");
const testFiles = args.filter((arg) => arg !== "--docker");

const compose = (...composeArgs) =>
  spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...composeArgs], { stdio: "inherit" }).status;

if (useDocker) {
  if (compose("up", "-d", "--wait") !== 0) process.exit(1);
  Object.assign(process.env, DOCKER_URLS);
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
