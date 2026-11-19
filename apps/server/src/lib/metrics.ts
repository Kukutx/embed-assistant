/** Tiny Prometheus text-format registry (no dependency). */
type Labels = Record<string, string>;
const key = (l: Labels) =>
  Object.entries(l)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`)
    .join(",");

class Counter {
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ""} ${v}`);
    return lines.join("\n");
  }
}

class Histogram {
  private buckets: number[];
  private data = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string, buckets: number[]) {
    this.buckets = buckets;
  }
  observe(value: number, labels: Labels = {}) {
    const k = key(labels);
    const d = this.data.get(k) ?? { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((b, i) => {
      if (value <= b) d.counts[i]!++;
    });
    d.sum += value;
    d.count++;
    this.data.set(k, d);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, d] of this.data) {
      const sep = k ? `,${k}` : "";
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{le="${b}"${sep}} ${d.counts[i]}`));
      lines.push(`${this.name}_bucket{le="+Inf"${sep}} ${d.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ""} ${d.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ""} ${d.count}`);
    }
    return lines.join("\n");
  }
}

export const metrics = {
  runs: new Counter("ea_runs_total", "Runs by final status and deployment"),
  failovers: new Counter("ea_model_failovers_total", "Failovers from one deployment to the next"),
  tokens: new Counter("ea_model_tokens_total", "Model tokens by direction and deployment"),
  ttft: new Histogram("ea_time_to_first_token_ms", "Time from run start to first text token", [100, 250, 500, 1000, 2000, 4000, 8000, 16000]),
  duration: new Histogram("ea_run_duration_ms", "Run duration", [500, 1000, 2000, 5000, 10000, 30000, 60000, 120000]),
  http: new Counter("ea_http_requests_total", "HTTP requests by route and status"),
  render(): string {
    return [this.runs, this.failovers, this.tokens, this.ttft, this.duration, this.http].map((m) => m.render()).join("\n\n") + "\n";
  },
};
