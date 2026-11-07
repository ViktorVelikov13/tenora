/** Another migrator holds the lock, or a run that crashed left it behind. Nothing was run. */
export class MigrationLockError extends Error {
  override readonly name = "MigrationLockError";
  readonly table: string;

  constructor(table: string) {
    super(
      `Tenora: the migrations are locked (${table}.is_locked = 1): another migrator is running, so nothing was run. If none is, a run that was killed left the lock behind; release it with forceUnlock().`
    );
    this.table = table;
  }
}

/** A migration's `up` or `down` threw. The database error, if any, is `cause`. */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
  readonly migration: string;
  readonly file: string;
  readonly direction: "up" | "down";
  /** false when what it changed before failing stays changed: MySQL and MariaDB, or `transaction: false` */
  readonly rolledBack: boolean;

  constructor(migration: string, file: string, direction: "up" | "down", rolledBack: boolean, note: string, cause: unknown) {
    const action = direction === "up" ? "migration" : "rolling back the migration";
    super(`Tenora: ${action} ${file} failed: ${(cause as Error)?.message ?? cause}${note ? ` ${note}` : ""}`, { cause });
    this.migration = migration;
    this.file = file;
    this.direction = direction;
    this.rolledBack = rolledBack;
  }
}

/** A seed threw. The seeds before it ran; the ones after it did not. */
export class SeedError extends Error {
  override readonly name = "SeedError";
  readonly seed: string;
  readonly file: string;

  constructor(seed: string, file: string, cause: unknown) {
    super(`Tenora: the seed ${file} failed: ${(cause as Error)?.message ?? cause}`, { cause });
    this.seed = seed;
    this.file = file;
  }
}
