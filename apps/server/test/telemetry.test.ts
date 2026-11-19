/** Tracing: HTTP server spans continue incoming traces; model calls get GenAI spans; outgoing requests carry traceparent. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { safeFetch } from "../src/knowledge/safeFetch.js";
import { createLogger } from "../src/lib/log.js";
import { telemetryEnabled, withSpan } from "../src/lib/telemetry.js";
import { ModelRegistry } from "../src/models/registry.js";
import type { ChatChunk, ChatModel } from "../src/models/types.js";
import { createServices } from "../src/services.js";

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

class TinyModel implements ChatModel {
  readonly id = "tiny";
  readonly provider = "test";
  readonly model = "tiny-1";
  available() {
    return true;
  }
  async *stream(): AsyncIterable<ChatChunk> {
    yield { type: "text", text: "hi" };
    yield { type: "usage", inputTokens: 7, outputTokens: 3 };
  }
}

describe("telemetry", () => {
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter as any)] });
    provider.register();
  });
  afterAll(() => provider.shutdown());

  it("is off unless an OTLP endpoint is configured", () => {
    expect(telemetryEnabled({})).toBe(false);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).toBe(true);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" })).toBe(false);
  });

  it("continues incoming traces on HTTP requests", async () => {
    exporter.reset();
    const cfg = loadConfig({ SECRET_KEY: "x".repeat(32), LOG_LEVEL: "silent", SERVE_WIDGET: "false", SERVE_CONSOLE: "false" });
    const s = createServices(cfg, { log: createLogger("silent"), models: new ModelRegistry({ deployments: [{ id: "extractive", provider: "builtin-extractive" }], aliases: { standard: ["extractive"] } }) });
    const app = createApp(s);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const res = await app.request("/healthz", { headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } });
    expect(res.status).toBe(200);
    const span = exporter.getFinishedSpans().find((x) => x.name === "GET /healthz")!;
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.attributes).toMatchObject({ "http.route": "/healthz", "http.response.status_code": 200 });
    await s.sql.end({ timeout: 1 });
  });

  it("records GenAI spans for model calls without content", async () => {
    exporter.reset();
    const models = new ModelRegistry({ deployments: [], aliases: { standard: [] } });
    models.register(new TinyModel(), ["standard"]);
    let text = "";
    for await (const { chunk } of models.stream("standard", { system: "s", messages: [{ role: "user", content: "secret question" }], question: "secret question", sources: [], maxOutputTokens: 100, signal: new AbortController().signal })) {
      if (chunk.type === "text") text += chunk.text;
    }
    expect(text).toBe("hi");
    const span = exporter.getFinishedSpans().find((x) => x.name === "chat tiny-1")!;
    expect(span.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "test",
      "gen_ai.request.model": "tiny-1",
      "gen_ai.usage.input_tokens": 7,
      "gen_ai.usage.output_tokens": 3,
      "gen_ai.response.finish_reasons": ["stop"],
    });
    expect(JSON.stringify(span.attributes)).not.toContain("secret question");
  });

  it("propagates traceparent on outgoing requests", async () => {
    let seen = "";
    const srv = createServer((rq, rs) => {
      seen = String(rq.headers.traceparent ?? "");
      rs.end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
    const traceId = await withSpan("outer", {}, async (span) => {
      await safeFetch(url, { allowPrivate: true });
      return span.spanContext().traceId;
    });
    srv.close();
    expect(seen).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
  });
});
