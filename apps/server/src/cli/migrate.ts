import { loadConfig } from "../config.js";
import { createSql } from "../db/pool.js";
import { migrate } from "../db/migrate.js";

const cfg = loadConfig();
const sql = createSql(cfg.DATABASE_URL, 1);
try {
  const applied = await migrate(sql);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
} finally {
  await sql.end({ timeout: 5 });
}
