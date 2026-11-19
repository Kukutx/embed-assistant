/**
 * OpenTelemetry tracing.
 *
 * The code only uses `@opentelemetry/api`, which is a no-op until an SDK is
 * registered. The SDK is loaded when an OTLP endpoint is configured with the
 * standard variables (OTEL_EXPORTER_OTLP_ENDPOINT or
 * OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, plus OTEL_EXPORTER_OTLP_HEADERS,
 * OTEL_SERVICE_NAME, OTEL_TRACES_SAMPLER, ...), so any backend works:
 * Jaeger, Tempo, Honeycomb, Datadog, New Relic, Elastic, Langfuse, ...
 *
 * Spans follow the OpenTelemetry semantic conventions for HTTP and GenAI
 * (`gen_ai.*`). Message contents are never recorded.
 */
import { context, propagation, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

export const tracer = trace.getTracer("embed-assistant");

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OTEL_SDK_DISABLED === "true") return false;
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

/** Register the tracing SDK when configured. Safe to call once at startup. */
export async function initTelemetry(version: string, env: NodeJS.ProcessEnv = process.env): Promise<TelemetryHandle | null> {
  if (!telemetryEnabled(env)) return null;
  const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { resourceFromAttributes }] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
  ]);
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": env.OTEL_SERVICE_NAME || "embed-assistant",
      "service.version": version,
    }),
    // The exporter and the processor read the standard OTEL_* variables.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter() as any)],
  });
  // Global provider, AsyncLocalStorage context manager, W3C trace-context + baggage propagation.
  provider.register();
  return { shutdown: () => provider.shutdown() };
}

/** Run `fn` inside a new active span; records errors and ends the span. */
export async function withSpan<T>(
  name: string,
  opts: { kind?: SpanKind; attributes?: Attributes },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, ...(opts.attributes ? { attributes: opts.attributes } : {}) }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      recordError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

export function recordError(span: Span, err: unknown): void {
  const e = err as Error;
  span.recordException(e);
  span.setAttribute("error.type", e?.name || "Error");
  span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message?.slice(0, 200) });
}

/** Add W3C `traceparent`/`tracestate` for the active span to outgoing headers. */
export function injectTraceHeaders(headers: Record<string, string>): Record<string, string> {
  propagation.inject(context.active(), headers);
  return headers;
}

/** Continue the caller's trace (incoming `traceparent`) for the duration of `fn`. */
export function withIncomingContext<T>(headers: Record<string, string | undefined>, fn: () => T): T {
  const carrier = Object.fromEntries(Object.entries(headers).filter((e): e is [string, string] => typeof e[1] === "string"));
  return context.with(propagation.extract(context.active(), carrier), fn);
}

/** Ids of the active span, for log correlation. */
export function activeTraceIds(): { trace_id: string; span_id: string } | Record<string, never> {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && sc.traceId !== "00000000000000000000000000000000" ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
}

export { SpanKind, SpanStatusCode, type Span };
