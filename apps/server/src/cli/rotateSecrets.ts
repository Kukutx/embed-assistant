/**
 * Re-encrypt stored secrets with the current SECRET_KEY.
 *
 *   SECRET_KEY=<new> SECRET_KEY_PREVIOUS=<old> node dist/cli/rotateSecrets.js [--dry-run]
 */
import { loadConfig } from "../config.js";
import { createSql } from "../db/pool.js";
import { deriveKey, keyring } from "../lib/crypto.js";
import { rotateSecrets } from "../ops/rotateSecrets.js";

const cfg = loadConfig();
const dryRun = process.argv.includes("--dry-run");
const sql = createSql(cfg.DATABASE_URL, 1);
const key = keyring(
  deriveKey(cfg.SECRET_KEY, "widget-secret-encryption"),
  cfg.SECRET_KEY_PREVIOUS.map((k) => deriveKey(k, "widget-secret-encryption")),
);
try {
  const report = await rotateSecrets(sql, key, { dryRun });
  for (const r of report) {
    console.log(`${r.table}.${r.column}: ${r.total} stored, ${r.rotated} ${dryRun ? "to re-encrypt" : "re-encrypted"}${r.unreadable ? `, ${r.unreadable} UNREADABLE with the configured keys` : ""}`);
  }
  const unreadable = report.reduce((n, r) => n + r.unreadable, 0);
  if (unreadable) {
    console.error("Some values could not be decrypted: add the key that wrote them to SECRET_KEY_PREVIOUS and run again.");
    process.exitCode = 2;
  } else if (!dryRun) {
    console.log("Done. Every stored secret now uses SECRET_KEY. Remove SECRET_KEY_PREVIOUS once sessions signed with it have expired.");
  }
} finally {
  await sql.end({ timeout: 5 });
}
