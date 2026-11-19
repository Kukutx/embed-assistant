/**
 * Role-based access control for the admin API.
 *
 * Every admin route maps to one permission, derived centrally from its method
 * and path so that new routes are covered without per-route code. Anything
 * not listed explicitly needs `config:write` (or `security:manage` for the
 * security area), so a new endpoint is closed to read-only roles by default.
 */
import { ROLE_PERMISSIONS, type Permission, type Role } from "@embed-assistant/protocol";

/** Who is calling the admin API: an API key (full access) or a signed-in console user. */
export interface Actor {
  type: "api_key" | "user";
  id: string;
  name: string | null;
  email: string | null;
  role: Role;
  tenantId: string;
}

const SECURITY = new Set(["keys", "settings", "users", "sso", "audit-log"]);
const ANALYTICS = new Set(["insights", "usage"]);
const ANY = new Set(["me", "logout"]);

/**
 * Permission needed for `method path` (OpenAPI `{id}` or Hono `:id` style, with
 * or without the /v1/admin prefix). null = any signed-in actor.
 */
export function routePermission(method: string, path: string): Permission | null {
  const rel = path.replace(/^\/v1\/admin/, "");
  const segs = rel.split("/").filter(Boolean);
  const first = segs[0] ?? "";
  const read = method.toUpperCase() === "GET";
  if (ANY.has(first)) return null;
  if (SECURITY.has(first)) return "security:manage";
  if (ANALYTICS.has(first)) return "analytics:read";
  if (first === "conversations") {
    if (segs[1] === "export") return "conversations:export";
    if (read) return "conversations:read";
    if (segs[2] === "reply" || segs[2] === "assign" || segs[2] === "release" || segs[2] === "resolve") return "conversations:reply";
    return "conversations:delete";
  }
  if (first === "subjects") return "conversations:delete";
  if (read) return "config:read";
  if (first === "sources") return "knowledge:write";
  return "config:write";
}

export const can = (role: Role, p: Permission | null): boolean => p === null || ROLE_PERMISSIONS[role].includes(p);

export const permissionsOf = (role: Role): Permission[] => [...ROLE_PERMISSIONS[role]];

/** Roles a given role may assign or manage. Only owners manage owners. */
export const canManageRole = (actor: Role, target: Role): boolean => actor === "owner" || (actor === "admin" && target !== "owner");
