import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scryptSync } from "node:crypto";

const PASSWORD_CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";

/**
 * Generate a random password suitable for per-tenant DB users.
 */
export const generateTenantPassword = (length = 32): string => {
  let password = "";

  for (let i = 0; i < length; i++) {
    password += PASSWORD_CHARSET[randomInt(PASSWORD_CHARSET.length)];
  }

  return password;
};

// Format: "tenora:v1:" + base64(iv | auth tag | ciphertext), encrypted with AES-256-GCM.
const FORMAT_PREFIX = "tenora:v1:";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
// A fixed salt lets the key be derived once per process rather than once per tenant,
// so commands that touch every tenant don't pay for scrypt on each password.
const KEY_SALT = "tenora:v1";
// Values written with crypto-js (Tenora 0.3 and earlier) are base64 of "Salted__" + salt + ciphertext.
const LEGACY_PREFIX = "U2FsdGVkX1";

const derivedKeys = new Map<string, Buffer>();

const deriveKey = (cipherKey: string): Buffer => {
  let key = derivedKeys.get(cipherKey);
  if (!key) {
    key = scryptSync(cipherKey, KEY_SALT, 32);
    derivedKeys.set(cipherKey, key);
  }
  return key;
};

const assertCipherKey = (cipherKey: string) => {
  if (typeof cipherKey !== "string" || cipherKey.length === 0) {
    throw new Error("Tenora: cipherKey must be a non-empty string.");
  }
};

// OpenSSL's EVP_BytesToKey with MD5 and one round, which crypto-js uses to turn a passphrase into a key and IV.
const deriveLegacyKeyAndIv = (cipherKey: string, salt: Buffer) => {
  const blocks: Buffer[] = [];
  let block = Buffer.alloc(0);
  for (let length = 0; length < 48; length += block.length) {
    block = createHash("md5").update(block).update(cipherKey, "utf8").update(salt).digest();
    blocks.push(block);
  }
  const material = Buffer.concat(blocks);
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
};

const decryptLegacy = (encryptedPassword: string, cipherKey: string): string => {
  const raw = Buffer.from(encryptedPassword, "base64");
  const { key, iv } = deriveLegacyKeyAndIv(cipherKey, raw.subarray(8, 16));
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
};

const decryptCurrent = (encryptedPassword: string, cipherKey: string): string => {
  const raw = Buffer.from(encryptedPassword.slice(FORMAT_PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(cipherKey), raw.subarray(0, IV_LENGTH));
  decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  return Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]).toString("utf8");
};

export const encryptPassword = (password: string, cipherKey: string): string => {
  assertCipherKey(cipherKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(cipherKey), iv);
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return FORMAT_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
};

/**
 * Decrypts a value from `encryptPassword`, including values written by Tenora 0.3 and earlier.
 */
export const decryptPassword = (encryptedPassword: string, cipherKey: string): string => {
  assertCipherKey(cipherKey);
  try {
    if (encryptedPassword.startsWith(FORMAT_PREFIX)) return decryptCurrent(encryptedPassword, cipherKey);
    if (encryptedPassword.startsWith(LEGACY_PREFIX)) return decryptLegacy(encryptedPassword, cipherKey);
  } catch {
    // A wrong key or a damaged value gets the same error as an unknown format below.
  }
  throw new Error(
    "Tenora: could not decrypt the tenant password. Check that the cipher key (TENORA_KEY) is the one it was encrypted with."
  );
};
