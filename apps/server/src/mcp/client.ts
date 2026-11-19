/**
 * Minimal MCP client over Streamable HTTP, used to give assistants the tools of
 * remote MCP servers. It speaks the stateless 2026-07-28 protocol when the
 * server supports it and falls back to the legacy `initialize` handshake
 * (2025-03-26 .. 2025-11-25, optional Mcp-Session-Id) otherwise.
 *
 * All requests go through the SSRF-safe fetcher. Responses may be JSON or SSE.
 */
import type { McpRemoteTool } from "@embed-assistant/protocol";
import { safeFetch } from "../knowledge/safeFetch.js";
import {
  encodeHeaderValue,
  ERR,
  LATEST_LEGACY_VERSION,
  LATEST_VERSION,
  LEGACY_VERSIONS,
  META_CLIENT_CAPS,
  META_CLIENT_INFO,
  META_SERVER_INFO,
  META_VERSION,
  MODERN_VERSIONS,
  type McpToolDef,
  type McpToolResult,
} from "./protocol.js";

export interface McpConnection {
  url: string;
  headers: Record<string, string>;
  allowPrivate: boolean;
  timeoutMs?: number;
  clientVersion: string;
}

export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** Parse an SSE body into the JSON messages of its `data:` fields. */
export function parseSseMessages(body: string): Message[] {
  const out: Message[] = [];
  for (const block of body.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as Message);
    } catch {
      /* ignore partial or non-JSON events */
    }
  }
  return out;
}

let counter = 0;

export class McpClient {
  era: "modern" | "legacy" | null = null;
  protocolVersion: string | null = null;
  serverName: string | null = null;
  instructions: string | null = null;
  private sessionId: string | null = null;

  constructor(private readonly conn: McpConnection) {}

  private clientInfo() {
    return { name: "embed-assistant", version: this.conn.clientVersion };
  }

  /** Establish the protocol era (once per client). */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.era) return;
    try {
      const r = await this.send("server/discover", {}, { version: LATEST_VERSION, modern: true, signal });
      const supported = Array.isArray(r.supportedVersions) ? (r.supportedVersions as string[]) : [];
      const modern = MODERN_VERSIONS.find((v) => supported.includes(v));
      const meta = (r._meta ?? {}) as Record<string, { name?: string; title?: string }>;
      this.serverName = meta[META_SERVER_INFO]?.title ?? meta[META_SERVER_INFO]?.name ?? null;
      this.instructions = typeof r.instructions === "string" ? r.instructions : null;
      if (modern) {
        this.era = "modern";
        this.protocolVersion = modern;
        return;
      }
    } catch (err) {
      // A legacy server rejects the unknown method or the request shape; anything
      // else (network, auth) is a real failure.
      if (!(err instanceof McpRpcError) || err.httpStatus === 401 || err.httpStatus === 403) throw err;
    }
    await this.initializeLegacy(signal);
  }

  private async initializeLegacy(signal?: AbortSignal): Promise<void> {
    this.sessionId = null;
    const r = await this.send(
      "initialize",
      { protocolVersion: LATEST_LEGACY_VERSION, capabilities: {}, clientInfo: this.clientInfo() },
      { legacyInit: true, signal },
    );
    const v = typeof r.protocolVersion === "string" ? r.protocolVersion : LATEST_LEGACY_VERSION;
    if (!(LEGACY_VERSIONS as readonly string[]).includes(v)) throw new Error(`server wants unsupported protocol version ${v}`);
    this.era = "legacy";
    this.protocolVersion = v;
    const info = (r.serverInfo ?? {}) as { name?: string; title?: string };
    this.serverName = info.title ?? info.name ?? this.serverName;
    this.instructions = typeof r.instructions === "string" ? r.instructions : this.instructions;
    await this.notify("notifications/initialized", signal).catch(() => {});
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDef[]> {
    await this.connect(signal);
    const tools: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {}, signal);
      for (const t of (r.tools as McpToolDef[] | undefined) ?? []) if (t && typeof t.name === "string") tools.push(t);
      cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    await this.connect(signal);
    const r = await this.request("tools/call", { name, arguments: args }, signal);
    if (r.resultType === "input_required") {
      // Multi-round-trip requests (elicitation, sampling) need a person or a model on
      // the server's side of the loop; report it instead of hanging.
      return { content: [{ type: "text", text: "The tool needs additional input that this assistant cannot provide." }], isError: true };
    }
    return r as McpToolResult;
  }

  /** Request with one transparent retry when a legacy session expired. */
  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      return await this.send(method, params, { signal });
    } catch (err) {
      if (this.era === "legacy" && this.sessionId && err instanceof McpRpcError && err.httpStatus === 404) {
        await this.initializeLegacy(signal);
        return this.send(method, params, { signal });
      }
      throw err;
    }
  }

  private headers(method: string, params: Record<string, unknown>, version: string | null, modern: boolean): Record<string, string> {
    const h: Record<string, string> = {
      ...this.conn.headers,
      "content-type": "application/json",
    };
    if (version) h["mcp-protocol-version"] = version;
    if (modern) {
      h["mcp-method"] = method;
      if (method === "tools/call" && typeof params.name === "string") h["mcp-name"] = encodeHeaderValue(params.name);
    }
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  private async notify(method: string, signal?: AbortSignal): Promise<void> {
    const version = this.protocolVersion;
    await safeFetch(this.conn.url, {
      allowPrivate: this.conn.allowPrivate,
      method: "POST",
      headers: this.headers(method, {}, version, false),
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      timeoutMs: 10_000,
      maxBytes: 64 * 1024,
      accept: "application/json, text/event-stream",
      userAgent: `embed-assistant-mcp/${this.conn.clientVersion}`,
      ...(signal ? { signal } : {}),
    });
  }

  private async send(
    method: string,
    params: Record<string, unknown>,
    o: { version?: string; modern?: boolean; legacyInit?: boolean; signal?: AbortSignal | undefined },
  ): Promise<Record<string, unknown>> {
    const modern = o.modern ?? this.era === "modern";
    const version = o.legacyInit ? null : (o.version ?? this.protocolVersion);
    const id = `ea-${++counter}`;
    const body = {
      jsonrpc: "2.0",
      id,
      method,
      params: modern
        ? {
            ...params,
            _meta: { [META_VERSION]: version, [META_CLIENT_CAPS]: {}, [META_CLIENT_INFO]: this.clientInfo() },
          }
        : params,
    };
    const res = await safeFetch(this.conn.url, {
      allowPrivate: this.conn.allowPrivate,
      method: "POST",
      headers: this.headers(method, params, version, modern),
      body: JSON.stringify(body),
      timeoutMs: this.conn.timeoutMs ?? 30_000,
      maxBytes: 2 * 1024 * 1024,
      accept: "application/json, text/event-stream",
      userAgent: `embed-assistant-mcp/${this.conn.clientVersion}`,
      stopWhen: (b) => b.includes(`"${id}"`) && parseSseMessages(b).some((m) => m.id === id),
      ...(o.signal ? { signal: o.signal } : {}),
    });
    if (o.legacyInit && res.headers["mcp-session-id"]) this.sessionId = res.headers["mcp-session-id"];

    let msg: Message | undefined;
    if (/text\/event-stream/i.test(res.contentType)) msg = parseSseMessages(res.body).find((m) => m.id === id);
    else if (res.body.trim()) {
      try {
        msg = JSON.parse(res.body) as Message;
      } catch {
        msg = undefined;
      }
    }
    if (msg?.error) throw new McpRpcError(msg.error.code, msg.error.message, res.status, msg.error.data);
    if (res.status < 200 || res.status >= 300) {
      throw new McpRpcError(res.status === 404 ? ERR.methodNotFound : ERR.internal, `HTTP ${res.status}`, res.status);
    }
    if (!msg || !msg.result || typeof msg.result !== "object") throw new McpRpcError(ERR.internal, "invalid response from MCP server", res.status);
    return msg.result;
  }
}

/** Cached, model-facing shape of a remote tool. */
export function toRemoteTool(t: McpToolDef): McpRemoteTool {
  const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : {};
  return {
    name: t.name.slice(0, 128),
    title: typeof t.title === "string" ? t.title.slice(0, 100) : null,
    description: (typeof t.description === "string" ? t.description : "").slice(0, 2000),
    inputSchema: schema.type === "object" ? schema : { type: "object", properties: {} },
    readOnly: t.annotations?.readOnlyHint === true,
  };
}

/** Model-facing tool name: `<server>__<tool>`, restricted to the provider-safe charset and 64 chars. */
export function modelToolName(serverName: string, tool: string): string {
  return `${serverName}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 64);
}
