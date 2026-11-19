import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./pool.js";

const here = dirname(fileURLToPath(import.meta.url));
/** migrations/ lives next to src/ and dist/ */
export const MIGRATIONS_DIR = join(here, "..", "..", "migrations");

/** Apply pending *.sql migrations in order, each in its own transaction, under an advisory lock. */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(7243001)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const done = new Set((await tx<{ version: string }[]>`SELECT version FROM schema_migrations`).map((r) => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(dir, file), "utf8");
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
      applied.push(file);
    }
  });
  return applied;
}
