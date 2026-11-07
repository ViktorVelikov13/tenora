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

// Written by crypto-js 4.2.0, which Tenora 0.3 and earlier used, so they must keep decrypting.
const LEGACY_CIPHERTEXTS = [
  { key: "tenora-test-cipher-key", plain: "s3cret'pw", encrypted: "U2FsdGVkX1+nCw1SmImXafIjcvyZTUuvumlKwh9Ae8g=" },
  { key: "key", plain: "q7#Kd!x9&Zr2@Lp^Vm4*Tn8$Wb6%Yc1", encrypted: "U2FsdGVkX18a9JNgPG6ToUoiFwQl8tboxEeDaSrG5603HZyFsTuqggLMSCnSk3kS" },
  { key: "a much longer passphrase with spaces", plain: "pässwörd \"quoted\" 🔑", encrypted: "U2FsdGVkX19PiuFDyfMuyre4rZr+/UBmX8kRSg/Ny4ElnGaiPyxvO3Vn9N7b7gMW" },
  { key: "k", plain: "", encrypted: "U2FsdGVkX19ewiZYHY9aTIZkgv7YdcAFWVr6d97thJc=" },
];

describe("password helpers", () => {
  it("round-trips through encryption", () => {
    for (const plain of ["s3cret'pw", "pässwörd \"quoted\" 🔑", ""]) {
      const encrypted = encryptPassword(plain, "key");
      assert.notEqual(encrypted, plain);
      assert.equal(decryptPassword(encrypted, "key"), plain);
    }
  });

  it("writes the versioned format, with a fresh IV every time", () => {
    const first = encryptPassword("s3cret", "key");
    const second = encryptPassword("s3cret", "key");
    assert.match(first, /^tenora:v1:/);
    assert.notEqual(first, second);
  });

  for (const { key, plain, encrypted } of LEGACY_CIPHERTEXTS) {
    it(`decrypts a password stored by Tenora 0.3 (${JSON.stringify(plain)})`, () => {
      assert.equal(decryptPassword(encrypted, key), plain);
    });
  }

  it("refuses to decrypt with the wrong key", () => {
    const encrypted = encryptPassword("s3cret", "key");
    assert.throws(() => decryptPassword(encrypted, "other-key"), /could not decrypt/);
  });

  it("does not reveal a Tenora 0.3 password with the wrong key", () => {
    const [{ plain, encrypted }] = LEGACY_CIPHERTEXTS;
    let decrypted;
    try {
      decrypted = decryptPassword(encrypted, "other-key");
    } catch {
      decrypted = undefined;
    }
    assert.notEqual(decrypted, plain);
  });

  it("refuses a value that was tampered with or is not encrypted", () => {
    const encrypted = encryptPassword("s3cret", "key");
    // A character inside the IV: every bit there is checked, unlike the base64 padding at the end.
    const at = "tenora:v1:".length + 4;
    const tampered = encrypted.slice(0, at) + (encrypted[at] === "A" ? "B" : "A") + encrypted.slice(at + 1);
    assert.throws(() => decryptPassword(tampered, "key"), /could not decrypt/);
    assert.throws(() => decryptPassword("s3cret", "key"), /could not decrypt/);
  });

  it("requires a key", () => {
    assert.throws(() => encryptPassword("pw", ""), /cipherKey/);
    assert.throws(() => decryptPassword("pw", ""), /cipherKey/);
  });

  it("generates passwords of the requested length from the same characters", () => {
    assert.equal(generateTenantPassword().length, 32);
    assert.equal(generateTenantPassword(12).length, 12);
    assert.notEqual(generateTenantPassword(), generateTenantPassword());
    assert.match(generateTenantPassword(200), /^[a-zA-Z0-9!@#$%^&*]{200}$/);
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
