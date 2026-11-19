import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * SSRF-safe fetch for ingestion. Every DNS answer is checked against private,
 * loopback, link-local and metadata ranges at CONNECT time (so DNS rebinding
 * cannot slip through), redirects are followed manually and re-validated,
 * and bodies are size- and time-limited.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1]!, "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true;
}

export class FetchBlockedError extends Error {}

export interface SafeFetchOptions {
  allowPrivate: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
}

export interface FetchedDocument {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

const USER_AGENT = "embed-assistant-ingest/1.0 (+https://github.com/kukutx/embed-assistant)";

function makeAgent(allowPrivate: boolean): Agent {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err, "", 0);
          const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
          const bad = !allowPrivate && list.find((a) => isPrivateAddress(a.address));
          if (bad) return callback(new FetchBlockedError(`blocked address ${bad.address} for ${hostname}`), "", 0);
          if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
          const first = list[0]!;
          callback(null, first.address, first.family);
        });
      },
    },
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
  });
}

const agents = new Map<boolean, Agent>();

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<FetchedDocument> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const agent = agents.get(opts.allowPrivate) ?? makeAgent(opts.allowPrivate);
  agents.set(opts.allowPrivate, agent);
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchBlockedError(`unsupported protocol ${url.protocol}`);
    if (url.username || url.password) throw new FetchBlockedError("credentials in URL are not allowed");
    if (!opts.allowPrivate && isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))) {
      throw new FetchBlockedError(`blocked address ${url.hostname}`);
    }
    const res = await undiciFetch(url, {
      dispatcher: agent,
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      headers: { "user-agent": USER_AGENT, accept: opts.accept ?? "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5" },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) {
      await res.body?.cancel();
      throw new FetchBlockedError(`response too large (${declared} bytes)`);
    }
    let received = 0;
    const chunks: Uint8Array[] = [];
    if (res.body) {
      for await (const chunk of res.body) {
        received += chunk.byteLength;
        if (received > maxBytes) throw new FetchBlockedError(`response exceeds ${maxBytes} bytes`);
        chunks.push(chunk);
      }
    }
    return {
      url: url.toString(),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
    };
  }
  throw new FetchBlockedError("too many redirects");
}
