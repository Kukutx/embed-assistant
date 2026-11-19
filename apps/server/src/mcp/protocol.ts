/**
 * Model Context Protocol constants shared by the MCP server (/mcp) and the
 * MCP client (remote servers used as assistant tools).
 *
 * Two eras are supported:
 * - modern (2026-07-28): stateless, every request carries `_meta` with the
 *   protocol version, `server/discover` replaces `initialize`, results carry `resultType`;
 * - legacy (2025-03-26 .. 2025-11-25): `initialize` handshake, optional `Mcp-Session-Id`.
 */
export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SUPPORTED_VERSIONS: string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const LATEST_VERSION = MODERN_VERSIONS[0];
export const LATEST_LEGACY_VERSION = LEGACY_VERSIONS[0];

export const META_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  missingClientCapability: -32021,
  unsupportedVersion: -32022,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpContentItem {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface McpToolResult {
  content?: McpContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Header values that are not plain printable ASCII travel as `=?base64?<b64>?=` (2026-07-28).
 */
export function decodeHeaderValue(v: string | undefined | null): string | undefined {
  if (v === undefined || v === null) return undefined;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v.trim());
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : v.trim();
}

export function encodeHeaderValue(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) && v.trim() === v ? v : `=?base64?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/** Turn a tool result into text for a language model. */
export function toolResultText(r: McpToolResult, max = 16_000): string {
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "resource_link") parts.push(`[resource] ${String(c.name ?? c.title ?? "")} ${String(c.uri ?? "")}`.trim());
    else if (c.type === "resource" && c.resource && typeof c.resource === "object") {
      const res = c.resource as { uri?: string; text?: string };
      parts.push(res.text ?? `[resource] ${res.uri ?? ""}`);
    } else parts.push(`[${c.type} content omitted]`);
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  const s = parts.join("\n\n");
  return s.length > max ? `${s.slice(0, max)}… (truncated)` : s;
}
