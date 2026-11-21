type EncodedStatement = { sql: string; values: unknown[] };
type StatementCall =
  | { method: "all" | "run"; statement: EncodedStatement }
  | { method: "first"; statement: EncodedStatement; column?: string }
  | { method: "raw"; statement: EncodedStatement; columnNames: boolean };

export type RunD1Operation =
  | StatementCall
  | { method: "batch"; statements: EncodedStatement[] }
  | { method: "exec"; sql: string };

export type RunD1Binding = Pick<D1Database, "prepare" | "batch" | "exec">;

/** Build statements synchronously, and send only SQL and bound values across the run fence. */
export function createRunD1Binding(invoke: (operation: RunD1Operation) => Promise<unknown>): RunD1Binding {
  const descriptors = new WeakMap<D1PreparedStatement, EncodedStatement>();

  const prepare = (statement: EncodedStatement): D1PreparedStatement => {
    const prepared: D1PreparedStatement = {
      bind: (...values) => prepare({ sql: statement.sql, values }),
      first: (column?: string) => invoke({ method: "first", statement, column }) as Promise<never>,
      all: () => invoke({ method: "all", statement }) as Promise<never>,
      run: () => invoke({ method: "run", statement }) as Promise<never>,
      raw: (options?: { columnNames?: boolean }) =>
        invoke({ method: "raw", statement, columnNames: options?.columnNames ?? false }) as Promise<never>,
    };
    descriptors.set(prepared, statement);
    return prepared;
  };

  return {
    prepare: (sql) => prepare({ sql, values: [] }),
    async batch<T>(statements: D1PreparedStatement[]) {
      const encoded = statements.map((statement) => {
        const descriptor = descriptors.get(statement);
        if (!descriptor) throw new TypeError("Invalid prepared statement for this D1 binding");
        return descriptor;
      });
      return (await invoke({ method: "batch", statements: encoded })) as D1Result<T>[];
    },
    exec: (sql) => invoke({ method: "exec", sql }) as Promise<D1ExecResult>,
  };
}

/** Call from RunBindingProxy.perform() so all execution is admitted and drained by the slot. */
export function executeRunD1Operation(database: RunD1Binding, operation: RunD1Operation) {
  const prepare = ({ sql, values }: EncodedStatement) => database.prepare(sql).bind(...values);
  if (operation.method === "exec") return database.exec(operation.sql);
  if (operation.method === "batch") return database.batch(operation.statements.map(prepare));

  const statement = prepare(operation.statement);
  switch (operation.method) {
    case "first":
      return operation.column === undefined ? statement.first() : statement.first(operation.column);
    case "raw":
      return operation.columnNames ? statement.raw({ columnNames: true }) : statement.raw();
    case "run":
      return statement.run();
    case "all":
      return statement.all();
  }
}

const quoteSqliteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

export type D1ResetMode = "drop" | "truncate";

/** Clears a D1 database between fenced runs, either by dropping all objects or truncating all tables. */
export async function clearD1Database(database: RunD1Binding, mode: D1ResetMode = "drop"): Promise<void> {
  if (mode === "truncate") {
    const { results } = await database
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')",
      )
      .all<{ name: string; sql: string | null }>();
    if (results.length === 0) return;

    const virtualPrefixes = results
      .filter((row) => typeof row.sql === "string" && /^CREATE VIRTUAL TABLE\b/i.test(row.sql.trim()))
      .map((row) => `${row.name}_`);
    const tables = results.filter((row) => !virtualPrefixes.some((prefix) => row.name.startsWith(prefix)));
    if (tables.length === 0) return;

    await database.batch([
      database.prepare("PRAGMA defer_foreign_keys = ON"),
      ...tables.map((row) => database.prepare(`DELETE FROM ${quoteSqliteIdentifier(row.name)}`)),
    ]);
    return;
  }

  const { results } = await database
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('trigger', 'view', 'table')",
    )
    .all<{ type: string; name: string }>();
  if (results.length === 0) return;

  const triggers = results.filter((row) => row.type === "trigger");
  const views = results.filter((row) => row.type === "view");
  const tables = results.filter((row) => row.type === "table");

  const statements = [
    database.prepare("PRAGMA foreign_keys = OFF"),
    ...triggers.map((row) => database.prepare(`DROP TRIGGER IF EXISTS ${quoteSqliteIdentifier(row.name)}`)),
    ...views.map((row) => database.prepare(`DROP VIEW IF EXISTS ${quoteSqliteIdentifier(row.name)}`)),
    ...tables.map((row) => database.prepare(`DROP TABLE IF EXISTS ${quoteSqliteIdentifier(row.name)}`)),
    database.prepare("PRAGMA foreign_keys = ON"),
  ];
  await database.batch(statements);
}
