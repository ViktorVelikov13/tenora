import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { assertOk, createProject, repoRoot } from "./support/project.mjs";

const npm = (args, cwd) => {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8", timeout: 300_000 });
  assert.equal(result.status, 0, `npm ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
};

describe("packed tarballs", () => {
  const tarballs = {};
  let packDir;
  const projects = [];

  before(() => {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), "tenora-pack-"));
    for (const name of ["orm", "core", "cli", "multi-tenant"]) {
      const output = npm(["pack", "-w", `@tenora/${name}`, "--pack-destination", packDir], repoRoot);
      tarballs[name] = path.join(packDir, output.trim().split("\n").at(-1));
    }
  });

  after(() => {
    fs.rmSync(packDir, { recursive: true, force: true });
    for (const project of projects) project.remove();
  });

  for (const packageName of ["cli", "multi-tenant"]) {
    it(`@tenora/${packageName} installs and its tenora binary works in a fresh project`, () => {
      const project = createProject();
      projects.push(project);
      npm(
        [
          "install",
          "--no-audit",
          "--no-fund",
          tarballs.orm,
          tarballs.core,
          tarballs[packageName],
          "better-sqlite3",
        ],
        project.dir
      );
      project.write(
        "tenora.config.js",
        `export default {
  base: {
    client: "better-sqlite3",
    database: "data/base.sqlite",
    migrationsDir: "migrations/base",
  },
};
`
      );
      const bin = path.join(project.dir, "node_modules/.bin/tenora");
      const tenora = (args) => {
        const result = spawnSync(bin, args, { cwd: project.dir, encoding: "utf8", timeout: 60_000 });
        return { ...result, output: `${result.stdout}${result.stderr}` };
      };

      assert.match(assertOk(tenora(["list"])).stdout, /migrate:tenants/);
      assertOk(tenora(["migrate", "--create-base"]));
      assert.match(assertOk(tenora(["migrate"])).stdout, /create_tenant_registry/);
      assert.ok(fs.existsSync(project.path("data/base.sqlite")));
      assert.equal(fs.existsSync(project.path("node_modules/knex")), false, "Knex must not be installed");
      assert.equal(fs.existsSync(project.path("node_modules/objection")), false, "Objection must not be installed");
    });
  }

  it("the published entry point imports from an installed package", () => {
    const project = createProject();
    projects.push(project);
    npm(
      ["install", "--no-audit", "--no-fund", tarballs.orm, tarballs.core, tarballs["multi-tenant"]],
      project.dir
    );
    project.write(
      "check.js",
      `import { createTenoraFactory, defineTenoraConfig, generateTenantPassword } from "@tenora/multi-tenant";
console.log(typeof createTenoraFactory, typeof defineTenoraConfig, generateTenantPassword(4).length);
`
    );

    const result = spawnSync(process.execPath, ["check.js"], { cwd: project.dir, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "function function 4");
  });
});
