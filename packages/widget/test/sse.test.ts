import { describe, expect, it } from "vitest";
import { parseSse } from "../src/client.js";
import { stringsFor } from "../src/i18n.js";
import * as protocol from "@embed-assistant/protocol";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MEDIA_TYPES, ATTACHMENTS_PER_MESSAGE } from "../src/shared.js";

describe("attachment limits", () => {
  it("match the server's", () => {
    expect(ATTACHMENT_MEDIA_TYPES).toEqual([...protocol.ATTACHMENT_MEDIA_TYPES]);
    expect(ATTACHMENT_MAX_BYTES).toBe(protocol.ATTACHMENT_MAX_BYTES);
    expect(ATTACHMENTS_PER_MESSAGE).toBe(protocol.ATTACHMENTS_PER_MESSAGE);
  });
});

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

describe("parseSse", () => {
  it("parses frames split across chunks, ignoring comments", async () => {
    const out = [];
    for await (const e of parseSse(streamOf(": keepalive\n\n", "event: message.delta\nda", "ta: {\"a\":1}\nid: 4\n\r\n", "data: x\ndata: y\n\n"))) out.push(e);
    expect(out).toEqual([
      { event: "message.delta", data: '{"a":1}', id: "4" },
      { event: "message", data: "x\ny", id: "4" },
    ]);
  });
});

describe("stringsFor", () => {
  it("picks the base language and falls back to English", () => {
    expect(stringsFor("zh-CN").lang).toBe("zh");
    expect(stringsFor(undefined, "it-IT").lang).toBe("it");
    expect(stringsFor("xx").lang).toBe("en");
  });
});
