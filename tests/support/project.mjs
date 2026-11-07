import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const CLI_BIN = path.join(repoRoot, "packages/cli/dist/cli.js");
export const MULTI_TENANT_BIN = path.join(repoRoot, "packages/multi-tenant/dist/cli.js");

/** A throwaway consumer project: the working directory the CLI really runs in. */
export const createProject = ({ type = "module" } = {}) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tenora-test-")));
  const inProject = (...segments) => path.join(dir, ...segments);

  const write = (relativePath, content) => {
    fs.mkdirSync(path.dirname(inProject(relativePath)), { recursive: true });
    fs.writeFileSync(inProject(relativePath), content);
  };

  write(
    "package.json",
    JSON.stringify({ name: "tenora-test-project", private: true, ...(type ? { type } : {}) }, null, 2)
  );

  return {
    dir,
    path: inProject,
    write,
    read: (relativePath) => fs.readFileSync(inProject(relativePath), "utf8"),
    delete: (relativePath) => fs.rmSync(inProject(relativePath)),
    list: (relativePath) =>
      fs.existsSync(inProject(relativePath)) ? fs.readdirSync(inProject(relativePath)).sort() : [],
    writeConfig: (config, file = "tenora.config.js") =>
      write(
        file,
        type === "module"
          ? `export default ${JSON.stringify(config, null, 2)};\n`
          : `module.exports = ${JSON.stringify(config, null, 2)};\n`
      ),
    tenora: (args, { bin = CLI_BIN, env = {} } = {}) => {
      const result = spawnSync(process.execPath, [bin, ...args], {
        cwd: dir,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ...env },
      });
      return { ...result, output: `${result.stdout}${result.stderr}` };
    },
    remove: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

export const assertOk = (result) => {
  assert.equal(result.status, 0, `expected exit code 0, got ${result.status}:\n${result.output}`);
  return result;
};

export const assertFailed = (result) => {
  assert.notEqual(result.status, 0, `expected a failure, but it exited 0:\n${result.output}`);
  return result;
};

/** Path, relative to the project, of the single file that a make:* command printed. */
export const createdFile = (project, result) =>
  path.relative(project.dir, result.stdout.trim().split("\n").at(-1));
