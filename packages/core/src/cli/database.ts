import fs from "fs";
import path from "path";
import { sql } from "@tenora/orm";
import { connectToDatabase, resolveAdminDatabase, resolveBaseDatabaseName } from "../factory/connection";
import {
  escapeMssqlIdent,
  escapeMysqlIdent,
  escapePgIdent,
  isMssqlClient,
  isMysqlClient,
  isPostgresClient,
  isSqliteClient,
  resolveClient,
  runText,
} from "../factory/shared";
import type { CliConfig } from "../types";

export const ensureBaseDatabase = async (cfg: CliConfig) => {
  const client = resolveClient(cfg.base.client);
  const baseDb = resolveBaseDatabaseName(cfg.base);

  if (isSqliteClient(client)) {
    if (baseDb === ":memory:") return;
    fs.mkdirSync(path.dirname(baseDb), { recursive: true });
    if (!fs.existsSync(baseDb)) {
      fs.closeSync(fs.openSync(baseDb, "a"));
      console.log(`Tenora: created base database "${baseDb}"`);
    }
    return;
  }

  const admin = connectToDatabase(cfg.base, resolveAdminDatabase(cfg.base));

  try {
    if (isPostgresClient(client)) {
      const existing = await admin.raw(sql`SELECT 1 FROM pg_database WHERE datname = ${baseDb}`);
      if (existing.length) return;

      await runText(admin, `CREATE DATABASE "${escapePgIdent(baseDb)}"`);
    } else if (isMysqlClient(client)) {
      const existing = await admin.raw(sql`SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ${baseDb}`);
      if (existing.length) return;

      await runText(admin, `CREATE DATABASE \`${escapeMysqlIdent(baseDb)}\``);
    } else if (isMssqlClient(client)) {
      const existing = await admin.raw(sql`SELECT name FROM sys.databases WHERE name = ${baseDb}`);
      if (existing.length) return;

      await runText(admin, `CREATE DATABASE [${escapeMssqlIdent(baseDb)}]`);
    } else {
      throw new Error(
        `Tenora: --create-base is only supported for Postgres, MySQL/MariaDB, SQLite, and SQL Server clients (got "${client}").`
      );
    }
    console.log(`Tenora: created base database "${baseDb}"`);
  } finally {
    await admin.destroy();
  }
};
