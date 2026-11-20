import { afterEach, describe, expect, it, vi } from "vitest";
import { toAnthropicMessages, withCacheMarkers } from "../src/models/anthropic.js";
import { OpenAICompatibleChat, toOpenAIMessages } from "../src/models/openaiCompatible.js";
import type { ChatChunk, ChatTurn } from "../src/models/types.js";
import { redactPii } from "../src/lib/pii.js";
import { validateArguments } from "../src/lib/jsonSchema.js";
import { buildActionRequest } from "../src/actions/actions.js";
import { signWebhook } from "../src/webhooks/webhooks.js";

const transcript: ChatTurn[] = [
  { role: "user", content: "status of A-1?" },
  { role: "assistant", content: "Checking.", toolCalls: [{ id: "c1", name: "get_order", input: { id: "A-1" } }] },
  { role: "tool", results: [{ callId: "c1", name: "get_order", content: '{"status":"shipped"}' }] },
];

describe("provider transcripts", () => {
  it("maps tool turns to the Messages API", () => {
    expect(toAnthropicMessages(transcript)).toEqual([
      { role: "user", content: "status of A-1?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "c1", name: "get_order", input: { id: "A-1" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: '{"status":"shipped"}' }] },
    ]);
    // Raw provider content (e.g. reasoning blocks) is replayed verbatim to the same provider.
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "c1", name: "get_order", input: {} }];
    const withRaw: ChatTurn[] = [{ role: "assistant", content: "", toolCalls: [], raw: { provider: "anthropic", content: raw } }];
    expect(toAnthropicMessages(withRaw)[0]!.content).toBe(raw);
  });

  it("maps tool turns to Chat Completions", () => {
    expect(toOpenAIMessages(transcript)).toEqual([
      { role: "user", content: "status of A-1?" },
      { role: "assistant", content: "Checking.", tool_calls: [{ id: "c1", type: "function", function: { name: "get_order", arguments: '{"id":"A-1"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"status":"shipped"}' },
    ]);
  });
});

describe("OpenAI-compatible streaming tool calls", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("assembles tool calls split across deltas", async () => {
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "get_", arguments: '{"id"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "order", arguments: ':"A-1"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_10", function: { name: "noop", arguments: "" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ];
    const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const m = new OpenAICompatibleChat({ id: "o", baseUrl: "https://api.example/v1", model: "m", requiresKey: false });
    const chunks: ChatChunk[] = [];
    for await (const c of m.stream({
      system: "s",
      messages: [{ role: "user", content: "q" }],
      question: "q",
      sources: [],
      maxOutputTokens: 100,
      signal: new AbortController().signal,
      tools: [{ name: "get_order", description: "d", parameters: { type: "object" } }],
    })) chunks.push(c);
    expect(sent.tools).toEqual([{ type: "function", function: { name: "get_order", description: "d", parameters: { type: "object" } } }]);
    expect(chunks.filter((c) => c.type === "tool_call")).toEqual([
      { type: "tool_call", call: { id: "call_9", name: "get_order", input: { id: "A-1" } } },
      { type: "tool_call", call: { id: "call_10", name: "noop", input: {} } },
    ]);
    expect(chunks).toContainEqual({ type: "usage", inputTokens: 7, outputTokens: 3 });
  });
});

describe("helpers", () => {
  it("redacts personal data but keeps ordinary numbers", () => {
    expect(redactPii("write to a.b+c@mail.example.org")).toBe("write to [email]");
    expect(redactPii("card 4111-1111-1111-1111 ok")).toBe("card [card] ok");
    expect(redactPii("not a card 1234 5678 9012 3456")).toBe("not a card 1234 5678 9012 3456");
    expect(redactPii("IBAN DE89 3704 0044 0532 0130 00")).toBe("IBAN [iban]");
    expect(redactPii("call +1 (415) 555-0100 now")).toBe("call [phone] now");
    expect(redactPii("order 12345 on 2026-11-19, version 1.2.3")).toBe("order 12345 on 2026-11-19, version 1.2.3");
  });

  it("validates tool arguments with JSON Schema", () => {
    const schema = { type: "object", properties: { n: { type: "integer", minimum: 1 } }, required: ["n"] };
    expect(validateArguments(schema, { n: 2 })).toBeNull();
    expect(validateArguments(schema, { n: 0 })).toMatch(/^n:/);
    expect(validateArguments(schema, { __invalid_json: "{" })).toBe("arguments were not valid JSON");
  });

  it("builds action requests from URL templates", () => {
    expect(buildActionRequest("GET", "https://api.example/orders/{id}", { id: "a/b c", expand: ["items", "x"], n: 1 })).toEqual({
      url: "https://api.example/orders/a%2Fb%20c?expand=items&expand=x&n=1",
      body: undefined,
    });
    expect(buildActionRequest("POST", "https://api.example/orders/{id}/notes", { id: "7", text: "hi" })).toEqual({
      url: "https://api.example/orders/7/notes",
      body: '{"text":"hi"}',
    });
  });

  it("signs webhooks per the Standard Webhooks test vector", () => {
    // From the Standard Webhooks reference implementations.
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const payload = '{"test": 2432232314}';
    expect(signWebhook(secret, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, payload)).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });
});

describe("prompt cache markers", () => {
  const cc = { type: "ephemeral" };
  it("marks the turn before the new question", () => {
    const m = withCacheMarkers([
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "answer" },
      { role: "user" as const, content: "<sources>...</sources> second" },
    ]);
    expect(m[1]!.content).toEqual([{ type: "text", text: "answer", cache_control: cc }]);
    expect(m[2]!.content).toBe("<sources>...</sources> second");
  });
  it("marks the last tool result in a tool loop, and leaves a first question alone", () => {
    const toolTurn = { role: "user" as const, content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] };
    const m = withCacheMarkers([{ role: "user" as const, content: "q" }, { role: "assistant" as const, content: [{ type: "tool_use", id: "t1", name: "s", input: {} }] }, toolTurn]);
    expect(m[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "x", cache_control: cc }]);
    expect(toolTurn.content[0]).not.toHaveProperty("cache_control");
    const single = [{ role: "user" as const, content: "q" }];
    expect(withCacheMarkers(single)).toBe(single);
  });
  it("skips blocks that cannot carry a marker", () => {
    const m = withCacheMarkers([
      { role: "assistant" as const, content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "..." }] },
      { role: "user" as const, content: "q" },
    ]);
    expect(m[0]!.content).toEqual([{ type: "text", text: "a", cache_control: cc }, { type: "thinking", thinking: "..." }]);
  });
});
