import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  createKnexFactory,
  createTenantResolver,
  createTenoraFactory,
  createTenoraFactoryAsync,
  decryptPassword,
  defineTenoraConfig,
  encryptPassword,
  generateTenantPassword,
} from "../packages/multi-tenant/dist/index.js";
import { createProject } from "./support/project.mjs";

describe("password helpers", () => {
  it("round-trips through encryption", () => {
    const encrypted = encryptPassword("s3cret'pw", "key");
    assert.notEqual(encrypted, "s3cret'pw");
    assert.equal(decryptPassword(encrypted, "key"), "s3cret'pw");
  });

  it("does not decrypt with the wrong key", () => {
    const encrypted = encryptPassword("s3cret", "key");
    let decrypted;
    try {
      decrypted = decryptPassword(encrypted, "other-key");
    } catch {
      decrypted = undefined;
    }
    assert.notEqual(decrypted, "s3cret");
  });

  it("requires a key", () => {
    assert.throws(() => encryptPassword("pw", ""), /cipherKey/);
    assert.throws(() => decryptPassword("pw", ""), /cipherKey/);
  });

  it("generates passwords of the requested length", () => {
    assert.equal(generateTenantPassword().length, 32);
    assert.equal(generateTenantPassword(12).length, 12);
    assert.notEqual(generateTenantPassword(), generateTenantPassword());
  });
});

describe("defineTenoraConfig", () => {
  it("returns the config unchanged", () => {
    const config = { base: { database: "base" } };
    assert.equal(defineTenoraConfig(config), config);
  });
});

describe("createTenantResolver", () => {
  const fakeManager = () => {
    const calls = [];
    return {
      calls,
      getTenant: (tenantId, password) => {
        calls.push({ tenantId, password });
        return { boundTo: tenantId };
      },
    };
  };

  it("does nothing when no tenant id is resolved", async () => {
    const manager = fakeManager();
    const resolve = createTenantResolver({ manager, tenantId: () => undefined });
    const req = {};

    assert.deepEqual(await resolve(req), {});
    assert.deepEqual(req, {});
    assert.equal(manager.calls.length, 0);
  });

  it("passes the provided password to the manager", async () => {
    const manager = fakeManager();
    const resolve = createTenantResolver({
      manager,
      tenantId: async () => "acme",
      passwordProvider: async (tenantId) => `pw-for-${tenantId}`,
    });

    await resolve({});

    assert.deepEqual(manager.calls, [{ tenantId: "acme", password: "pw-for-acme" }]);
  });

  it("does not attach anything when the authorizer rejects", async () => {
    const resolve = createTenantResolver({
      manager: fakeManager(),
      tenantId: () => "acme",
      authorizer: () => {
        throw new Error("forbidden");
      },
    });
    const req = {};

    await assert.rejects(resolve(req), /forbidden/);
    assert.deepEqual(req, {});
  });

  it("uses a custom attach instead of the default", async () => {
    const resolve = createTenantResolver({
      manager: fakeManager(),
      tenantId: () => "acme",
      attach: (req, tenantId, knex) => {
        req.tenant = { id: tenantId, db: knex };
      },
    });
    const req = {};

    await resolve(req);

    assert.deepEqual(req, { tenant: { id: "acme", db: { boundTo: "acme" } } });
  });
});

describe("factory", () => {
  const project = createProject();
  const config = { base: { client: "sqlite3", database: project.path("base.sqlite") } };
  project.writeConfig(config);

  after(() => {
    delete process.env.TENORA_CONFIG;
    project.remove();
  });

  for (const [name, create] of [
    ["createTenoraFactory", () => createTenoraFactory()],
    ["createTenoraFactoryAsync", () => createTenoraFactoryAsync()],
    ["createKnexFactory", () => createKnexFactory()],
  ]) {
    it(`${name}() loads the config named by TENORA_CONFIG`, async () => {
      process.env.TENORA_CONFIG = project.path("tenora.config.js");
      const manager = await create();
      try {
        assert.deepEqual(await manager.getBase().raw("select 1 as one"), [{ one: 1 }]);
      } finally {
        await manager.destroyAll();
      }
    });
  }

  it("caches tenant connections until destroyTenant closes them", async () => {
    const manager = createTenoraFactory(config);
    try {
      const first = manager.getTenant("acme");
      assert.equal(manager.getTenant("acme"), first);
      assert.notEqual(manager.getTenant("other"), first);

      await manager.destroyTenant("acme");

      const second = manager.getTenant("acme");
      assert.notEqual(second, first);
      assert.deepEqual(await second.raw("select 1 as one"), [{ one: 1 }]);
    } finally {
      await manager.destroyAll();
    }
  });
});
