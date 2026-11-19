import type {
  ClientToolDef,
  Conversation,
  HandoffResult,
  ConversationList,
  CreateRunResponse,
  MessageList,
  PageContext,
  PublicWidgetConfig,
  RunEvent,
  Session,
} from "@embed-assistant/protocol";
import type { UserTokenProvider } from "./shared.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter: number | null = null,
    /** Server request id (`x-request-id`), for support and log correlation. */
    readonly requestId: string | null = null,
  ) {
    super(message);
  }
}

const TERMINAL = new Set(["run.completed", "run.failed", "run.cancelled"]);

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    s.getItem("x");
    return s;
  } catch {
    return null;
  }
}

function randomId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Typed client for the public /v1 API, with session management and resumable SSE. */
export class Client {
  private session: Session | null = null;
  private sessionPromise: Promise<Session> | null = null;
  private tokenProvider: UserTokenProvider | null = null;
  private readonly store = storage();

  constructor(
    readonly base: string,
    readonly widgetId: string,
    private locale: string | undefined,
  ) {}

  /** Per-browser key namespace for this widget. */
  key(name: string): string {
    return `embed-assistant:${this.widgetId}:${name}`;
  }
  get(name: string): string | null {
    try {
      return this.store?.getItem(this.key(name)) ?? null;
    } catch {
      return null;
    }
  }
  set(name: string, value: string | null): void {
    try {
      if (value === null) this.store?.removeItem(this.key(name));
      else this.store?.setItem(this.key(name), value);
    } catch {
      /* storage full or blocked: degrade to in-memory */
    }
  }

  private anonymousId(): string {
    let id = this.get("anon");
    if (!id || !/^[A-Za-z0-9_-]{22,64}$/.test(id)) {
      id = randomId();
      this.set("anon", id);
    }
    return id;
  }

  setTokenProvider(p: UserTokenProvider | null): void {
    this.tokenProvider = p;
    this.session = null;
    if (p) this.set("session", null);
    this.sessionPromise = null;
  }

  get subjectKind(): "anonymous" | "user" | null {
    return this.session?.subject.kind ?? null;
  }

  async config(): Promise<PublicWidgetConfig> {
    return this.request<PublicWidgetConfig>("GET", `/v1/widgets/${encodeURIComponent(this.widgetId)}/config`, undefined, false);
  }

  private fresh(s: Session | null): s is Session {
    return !!s && Date.parse(s.expiresAt) - Date.now() > 60_000;
  }

  private async ensureSession(): Promise<Session> {
    if (this.fresh(this.session)) return this.session;
    // Anonymous sessions are reused across page loads (fewer requests, kinder to shared IPs).
    if (!this.tokenProvider) {
      try {
        const cached = JSON.parse(this.get("session") ?? "null") as Session | null;
        if (this.fresh(cached) && cached.subject.kind === "anonymous") return (this.session = cached);
      } catch {
        /* ignore corrupt cache */
      }
    }
    this.sessionPromise ??= (async () => {
      let userToken: string | undefined;
      if (this.tokenProvider) {
        try {
          userToken = (await this.tokenProvider()) ?? undefined;
        } catch (err) {
          console.warn("[embed-assistant] identify() provider failed; continuing anonymously", err);
        }
      }
      const s = await this.request<Session>(
        "POST",
        "/v1/sessions",
        { widgetId: this.widgetId, ...(userToken ? { userToken } : { anonymousId: this.anonymousId() }), ...(this.locale ? { locale: this.locale } : {}) },
        false,
      );
      this.session = s;
      this.set("session", s.subject.kind === "anonymous" ? JSON.stringify(s) : null);
      return s;
    })().finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }

  private async request<T>(method: string, path: string, body?: unknown, auth = true, retried = false): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) headers.authorization = `Bearer ${(await this.ensureSession()).token}`;
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
      });
    } catch {
      throw new ApiError(0, "network", "network error");
    }
    if (res.status === 401 && auth && !retried) {
      this.session = null;
      this.set("session", null);
      return this.request<T>(method, path, body, auth, true);
    }
    if (!res.ok) {
      let code = "internal_error";
      let message = res.statusText;
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string } };
        code = j.error?.code ?? code;
        message = j.error?.message ?? message;
      } catch {
        /* non-JSON error */
      }
      const ra = Number(res.headers.get("retry-after"));
      throw new ApiError(res.status, code, message, Number.isFinite(ra) && ra > 0 ? ra : null, res.headers.get("x-request-id"));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  createConversation(): Promise<Conversation> {
    return this.request("POST", "/v1/conversations", {});
  }
  listConversations(cursor?: string): Promise<ConversationList> {
    return this.request("GET", `/v1/conversations?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  }
  deleteConversation(id: string): Promise<void> {
    return this.request("DELETE", `/v1/conversations/${encodeURIComponent(id)}`);
  }
  listMessages(conversationId: string, cursor?: string): Promise<MessageList> {
    return this.request(
      "GET",
      `/v1/conversations/${encodeURIComponent(conversationId)}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
  }
  createRun(
    conversationId: string,
    content: string,
    context: PageContext | undefined,
    idempotencyKey: string,
    clientTools?: ClientToolDef[],
  ): Promise<CreateRunResponse> {
    return this.request("POST", `/v1/conversations/${encodeURIComponent(conversationId)}/runs`, {
      content,
      ...(context ? { context } : {}),
      ...(clientTools?.length ? { clientTools } : {}),
      idempotencyKey,
    });
  }
  toolResult(runId: string, body: { callId: string; approved?: boolean; output?: unknown; isError?: boolean }): Promise<void> {
    return this.request("POST", `/v1/runs/${encodeURIComponent(runId)}/tool-results`, body);
  }
  handoff(conversationId: string, reason?: string): Promise<HandoffResult> {
    return this.request("POST", `/v1/conversations/${encodeURIComponent(conversationId)}/handoff`, reason ? { reason } : {});
  }
  getConversation(id: string): Promise<Conversation> {
    return this.request("GET", `/v1/conversations/${encodeURIComponent(id)}`);
  }
  cancelRun(runId: string): Promise<unknown> {
    return this.request("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`);
  }
  feedback(messageId: string, rating: "up" | "down"): Promise<void> {
    return this.request("POST", `/v1/messages/${encodeURIComponent(messageId)}/feedback`, { rating });
  }

  newIdempotencyKey(): string {
    return randomId();
  }

  /**
   * Stream run events. Reconnects with Last-Event-ID after network drops, so
   * no event is lost or duplicated. Resolves after a terminal event.
   */
  async streamRun(runId: string, onEvent: (e: RunEvent) => void, signal: AbortSignal): Promise<void> {
    let lastSeq = 0;
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const session = await this.ensureSession();
        const res = await fetch(`${this.base}/v1/runs/${encodeURIComponent(runId)}/events`, {
          headers: { authorization: `Bearer ${session.token}`, accept: "text/event-stream", ...(lastSeq ? { "last-event-id": String(lastSeq) } : {}) },
          credentials: "omit",
          signal,
        });
        if (res.status === 401) {
          this.session = null;
          this.set("session", null);
          throw new ApiError(401, "unauthorized", "session expired");
        }
        if (!res.ok || !res.body) throw new ApiError(res.status, "stream_failed", `stream failed (${res.status})`);
        attempt = 0;
        for await (const e of parseSse(res.body)) {
          if (!e.data) continue;
          const event = JSON.parse(e.data) as RunEvent;
          if (event.seq <= lastSeq) continue;
          lastSeq = event.seq;
          onEvent(event);
          if (TERMINAL.has(event.type)) return;
        }
        // Stream ended without a terminal event (server limit or proxy timeout): resume.
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) throw err;
        if (++attempt > 6) throw err instanceof ApiError ? err : new ApiError(0, "network", "network error");
        await new Promise((r) => setTimeout(r, Math.min(8000, 400 * 2 ** attempt)));
      }
    }
  }
}

/** Minimal SSE parser over a fetch body (works where EventSource cannot send headers). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string; id: string | null }> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  let id: string | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === "\r" ? 2 : 1));
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n"), id };
          event = "message";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
        else if (field === "id") id = value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
