/**
 * Browser origin check for public widget endpoints.
 * - No Origin header (server-to-server, curl): allowed; abuse is bounded by rate limits and budgets.
 * - Allowed list must match exactly (scheme://host[:port]) or contain "*".
 * - An empty list allows no browser origin (fail closed).
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return true;
  if (allowed.includes("*")) return true;
  const normalized = origin.toLowerCase().replace(/\/$/, "");
  return allowed.some((a) => a.toLowerCase().replace(/\/$/, "") === normalized);
}
