import { randomToken } from "../lib/ids.js";
import { sha256 } from "../lib/crypto.js";

export const ADMIN_KEY_PREFIX = "ea_admin_";

export function generateAdminKey(): { key: string; hash: Buffer; prefix: string } {
  const key = ADMIN_KEY_PREFIX + randomToken(32);
  return { key, hash: sha256(key), prefix: key.slice(0, ADMIN_KEY_PREFIX.length + 6) };
}

export const hashAdminKey = (key: string): Buffer => sha256(key);
