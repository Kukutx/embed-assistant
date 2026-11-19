/**
 * Re-encrypt every stored secret with the current SECRET_KEY. Run it after
 * moving the old key to SECRET_KEY_PREVIOUS; once it reports nothing left
 * under an old key, SECRET_KEY_PREVIOUS can be removed.
 */
import type { Sql } from "../db/pool.js";
import { decrypt, encrypt, isCurrent } from "../lib/crypto.js";

/** Every encrypted column: table, primary key, column. */
export const ENCRYPTED_COLUMNS = [
  { table: "widgets", id: "id", column: "identity_secret" },
  { table: "actions", id: "id", column: "headers" },
  { table: "webhooks", id: "id", column: "secret" },
  { table: "mcp_servers", id: "id", column: "headers" },
  { table: "sso_configs", id: "tenant_id", column: "client_secret_enc" },
] as const;

export interface RotationReport {
  table: string;
  column: string;
  total: number;
  rotated: number;
  /** Values no configured key can decrypt (left unchanged). */
  unreadable: number;
}

export async function rotateSecrets(sql: Sql, key: Buffer, opts: { dryRun?: boolean } = {}): Promise<RotationReport[]> {
  const out: RotationReport[] = [];
  for (const c of ENCRYPTED_COLUMNS) {
    const report: RotationReport = { table: c.table, column: c.column, total: 0, rotated: 0, unreadable: 0 };
    await sql.begin(async (tx) => {
      const rows = await tx<{ id: string; value: string }[]>`
        SELECT ${tx(c.id)} AS id, ${tx(c.column)} AS value FROM ${tx(c.table)} WHERE ${tx(c.column)} IS NOT NULL FOR UPDATE`;
      report.total = rows.length;
      for (const r of rows) {
        if (isCurrent(key, r.value)) continue;
        let plain: string;
        try {
          plain = decrypt(key, r.value);
        } catch {
          report.unreadable++;
          continue;
        }
        report.rotated++;
        if (!opts.dryRun) await tx`UPDATE ${tx(c.table)} SET ${tx(c.column)} = ${encrypt(key, plain)} WHERE ${tx(c.id)} = ${r.id}`;
      }
    });
    out.push(report);
  }
  return out;
}
