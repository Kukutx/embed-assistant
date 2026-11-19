import { randomToken } from "../lib/ids.js";
import { sha256 } from "../lib/crypto.js";

export const ADMIN_KEY_PREFIX = "ea_admin_";

export const MCP_KEY_PREFIX = "ea_mcp_";

/** Keys with the admin scope start with ea_admin_, MCP-only keys with ea_mcp_. */
export function generateAdminKey(scopes: string[] = ["admin"]): { key: string; hash: Buffer; prefix: string } {
  const p = scopes.includes("admin") ? ADMIN_KEY_PREFIX : MCP_KEY_PREFIX;
  const key = p + randomToken(32);
  return { key, hash: sha256(key), prefix: key.slice(0, p.length + 6) };
}

export const isApiKey = (key: string): boolean => key.startsWith(ADMIN_KEY_PREFIX) || key.startsWith(MCP_KEY_PREFIX);

export const hashAdminKey = (key: string): Buffer => sha256(key);
