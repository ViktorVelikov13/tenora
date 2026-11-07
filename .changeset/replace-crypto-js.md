---
"@tenora/core": minor
"@tenora/cli": minor
"@tenora/multi-tenant": minor
---

Replace the unmaintained `crypto-js` with Node's built-in `crypto`.

- `encryptPassword` now uses AES-256-GCM and writes values starting with `tenora:v1:`. `decryptPassword` still reads passwords stored by earlier versions, so existing tenants keep working with no migration.
- `decryptPassword` with the wrong key, or on a damaged value, now throws a clear "could not decrypt the tenant password" error. Before, it could return an empty or garbled string.
- `generateTenantPassword` now uses a cryptographically secure random source instead of `Math.random()`. Length and characters are unchanged.
- `crypto-js` is no longer installed with Tenora. If your own code imports it, add it to your own dependencies. If your code decrypts registry values with crypto-js directly, switch to `decryptPassword`, which reads both formats.

The packages are now built with tsdown and TypeScript 7. They publish the same files with the same exports.
