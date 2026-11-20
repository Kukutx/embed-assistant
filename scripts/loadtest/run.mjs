// Load test for the chat API. See docs/operations.md, "Capacity".
// BASE=http://localhost:8787 WIDGET=wgt_... VUS=200 QUESTIONS=3 node scripts/loadtest/run.mjs
// Closed-loop load: VUS virtual visitors, each asks QUESTIONS questions in its own conversation, streaming the answer.
const B = process.env.BASE ?? "http://localhost:8787", W = process.env.WIDGET, VUS = +(process.env.VUS ?? 50), Q = +(process.env.QUESTIONS ?? 3);
const H = { origin: B, "content-type": "application/json" };
const ttft = [], total = [], errors = {};
const err = (k) => (errors[k] = (errors[k] ?? 0) + 1);
async function visitor(v) {
  const s = await fetch(`${B}/v1/sessions`, { method: "POST", headers: H, body: JSON.stringify({ widgetId: W, anonymousId: `load-${v}-${Date.now()}-abcdefghijklmnop` }) });
  if (s.status !== 201) return err(`session ${s.status}`);
  const A = { ...H, authorization: `Bearer ${(await s.json()).token}` };
  const c = await (await fetch(`${B}/v1/conversations`, { method: "POST", headers: A, body: "{}" })).json();
  for (let i = 0; i < Q; i++) {
    const t0 = performance.now();
    const r = await fetch(`${B}/v1/conversations/${c.id}/runs`, { method: "POST", headers: A, body: JSON.stringify({ content: `How do I embed the assistant? (${v}.${i})` }) });
    if (r.status !== 202) { err(`run ${r.status}`); continue; }
    const run = (await r.json()).run;
    const es = await fetch(`${B}/v1/runs/${run.id}/events`, { headers: A });
    const reader = es.body.getReader(); const dec = new TextDecoder(); let buf = "", first = 0, end = "";
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      if (!first && buf.includes("event: message.delta")) first = performance.now();
      const m = /event: (run\.completed|run\.failed|run\.cancelled)/.exec(buf); if (m) { end = m[1]; break; }
    }
    reader.cancel().catch(() => {});
    if (end !== "run.completed") { err(end || "stream ended"); continue; }
    ttft.push((first || performance.now()) - t0); total.push(performance.now() - t0);
  }
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0); };
const t = performance.now();
await Promise.all(Array.from({ length: VUS }, (_, v) => visitor(v)));
const secs = (performance.now() - t) / 1000;
console.log(JSON.stringify({ vus: VUS, answers: total.length, secs: +secs.toFixed(1), answersPerSec: +(total.length / secs).toFixed(1), firstTextMs: { p50: pct(ttft, 50), p95: pct(ttft, 95), p99: pct(ttft, 99) }, totalMs: { p50: pct(total, 50), p95: pct(total, 95) }, errors }));
