/**
 * A raw SQL fragment written with the `sql` template tag. Interpolated values become bound parameters; use
 * `sql.ref()` for identifiers and `sql.raw()` only for trusted text.
 */
export class RawSql {
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[]
  ) {}
}

/** An identifier inside a `sql` fragment, quoted for the dialect: `sql.ref("users.email")`. */
export class SqlIdentifier {
  constructor(readonly name: string) {}
}

/** Trusted SQL text inserted as is. Never pass user input. */
export class SqlText {
  constructor(readonly text: string) {}
}

type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): RawSql;
  ref(name: string): SqlIdentifier;
  raw(text: string): SqlText;
};

export const sql: SqlTag = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) => new RawSql([...strings], values),
  {
    ref: (name: string) => new SqlIdentifier(name),
    raw: (text: string) => new SqlText(text),
  }
);
