import postgres from "postgres";

export type Sql = postgres.Sql<{}>;

export function createSql(url: string, max: number): Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    // Keep timestamps as Date objects; JSON columns parsed automatically.
    transform: { undefined: null },
    // Type parameters on the client as v3 did (Date as timestamptz, arrays by element).
    infer: true,
  });
}
