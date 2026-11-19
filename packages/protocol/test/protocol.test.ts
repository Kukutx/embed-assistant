import { describe, expect, it } from "vitest";
import { AssistantInput, AssistantPatch, CreateRunRequest, CreateSessionRequest, RunEvent, WidgetPatch, isTerminalEvent } from "../src/index.js";

describe("protocol", () => {
  it("validates run requests", () => {
    expect(CreateRunRequest.parse({ content: "  hi  " }).content).toBe("hi");
    expect(CreateRunRequest.safeParse({ content: "" }).success).toBe(false);
    expect(CreateRunRequest.safeParse({ content: "x".repeat(4001) }).success).toBe(false);
    expect(CreateRunRequest.safeParse({ content: "x", context: { attributes: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])) } }).success).toBe(false);
  });

  it("requires anonymous ids with enough entropy", () => {
    expect(CreateSessionRequest.safeParse({ widgetId: "wgt_1", anonymousId: "short" }).success).toBe(false);
    expect(CreateSessionRequest.safeParse({ widgetId: "wgt_1", anonymousId: "a".repeat(22) }).success).toBe(true);
  });

  it("applies defaults on create but never on patch", () => {
    expect(AssistantInput.parse({ name: "A" })).toMatchObject({ modelAlias: "standard", groundedOnly: true, sourceIds: [] });
    expect(AssistantPatch.parse({ name: "B" })).toEqual({ name: "B" });
    expect(WidgetPatch.parse({ name: "W" })).toEqual({ name: "W" });
  });

  it("parses events and knows terminal types", () => {
    const e = RunEvent.parse({ seq: 1, runId: "run_1", ts: "2026-01-01T00:00:00Z", type: "message.delta", data: { messageId: "msg_1", text: "hi" } });
    expect(e.type).toBe("message.delta");
    expect(isTerminalEvent("run.failed")).toBe(true);
    expect(isTerminalEvent("message.delta")).toBe(false);
  });
});
