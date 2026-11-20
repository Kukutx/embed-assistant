// Stand-in model for load tests (see docs/operations.md, "Capacity").
// OpenAI-compatible mock with realistic pacing: TTFT_MS then CHUNKS chunks every GAP_MS.
import http from "node:http";
const TTFT = +(process.env.TTFT_MS ?? 600), CHUNKS = +(process.env.CHUNKS ?? 60), GAP = +(process.env.GAP_MS ?? 20);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", async () => {
    if (req.url.includes("embeddings")) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    await sleep(TTFT);
    for (let i = 0; i < CHUNKS; i++) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "word " } }] })}\n\n`); await sleep(GAP); }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 800, completion_tokens: CHUNKS } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}).listen(9912, () => console.log("mock on 9912"));
