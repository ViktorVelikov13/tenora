import CryptoJS from "crypto-js";

/**
 * Generate a random password suitable for per-tenant DB users.
 */
export const generateTenantPassword = (length = 32): string => {
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
  let password = "";

  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * charset.length);
    password += charset[randomIndex];
  }

  return password;
};

export const encryptPassword = (password: string, cipherKey: string): string => {
  return CryptoJS.AES.encrypt(password, cipherKey).toString();
};

export const decryptPassword = (encryptedPassword: string, cipherKey: string): string => {
  const bytes = CryptoJS.AES.decrypt(encryptedPassword, cipherKey);
  return bytes.toString(CryptoJS.enc.Utf8);
};
