import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import { Connection, type ConnectionConfig } from "@solana/web3.js";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { SocksProxyAgent } from "socks-proxy-agent";
import { config } from "./config.js";

// Why we may route RPC calls through a proxy:
//
// The public `api.devnet.solana.com` rate-limits by source IP — somewhere around
// 100 requests / 10s before you start seeing 429s. Each airdrop claim costs
// 3 RPC calls (getLatestBlockhash, sendRawTransaction, confirmTransaction),
// so you saturate that budget pretty fast once you parallelize.
//
// If you set PROXY_URL to a rotating residential proxy (or any proxy that
// gives each request a different outbound IP), the per-IP rate limit doesn't
// bite. Without a proxy, keep `pipelines` low (2–3) and you'll still make
// steady progress — it just ramps up more slowly.

function isSocksUrl(url: string): boolean {
  return url.startsWith("socks4://") || url.startsWith("socks5://");
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

// Build a fetch that tunnels through a SOCKS4/5 proxy. undici's fetch doesn't
// support SOCKS natively, so we bridge node:https/http with socks-proxy-agent.
function makeSocksFetch(proxyUrl: string): FetchFn {
  const agent = new SocksProxyAgent(proxyUrl);
  return async (input, init) => {
    const urlStr = typeof input === "string" ? input : input.toString();
    const url = new URL(urlStr);
    const lib = url.protocol === "https:" ? https : http;
    const body = init?.body ? String(init.body) : undefined;
    const headers: Record<string, string> = { host: url.host };
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const pair of init.headers) {
          const [k, v] = pair;
          if (k && v !== undefined) headers[k] = v;
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          if (v !== undefined) headers[k] = String(v);
        }
      }
    }
    if (body && !headers["content-length"]) {
      headers["content-length"] = String(Buffer.byteLength(body));
    }

    // settled guards against double resolve/reject — some proxy errors arrive
    // asynchronously after we've already gotten a response, which crashed
    // earlier versions. Now we swallow late errors instead.
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const resolveOnce = (r: Response) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const rejectOnce = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      try {
        const req = lib.request(
          {
            method: init?.method ?? "GET",
            host: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            agent,
            headers,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
              const responseHeaders = new Headers();
              for (const [k, v] of Object.entries(res.headers)) {
                if (Array.isArray(v)) responseHeaders.set(k, v.join(", "));
                else if (v !== undefined) responseHeaders.set(k, String(v));
              }
              resolveOnce(
                new Response(Buffer.concat(chunks), {
                  status: res.statusCode ?? 0,
                  statusText: res.statusMessage ?? "",
                  headers: responseHeaders,
                }),
              );
            });
            res.on("error", rejectOnce);
          },
        );
        req.on("error", rejectOnce);
        if (body) req.write(body);
        req.end();
      } catch (err) {
        rejectOnce(err as Error);
      }
    });
  };
}

// Build a fetch that tunnels through an HTTP(S) proxy via undici.
function makeHttpProxyFetch(proxyUrl: string): FetchFn {
  const agent = new ProxyAgent({ uri: proxyUrl });
  return (input, init) =>
    undiciFetch(typeof input === "string" ? input : input.toString(), {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    }) as unknown as Promise<Response>;
}

export function makeConnection(): Connection {
  const connConfig: ConnectionConfig = { commitment: "confirmed" };
  if (config.proxyUrl) {
    connConfig.fetch = (
      isSocksUrl(config.proxyUrl)
        ? makeSocksFetch(config.proxyUrl)
        : makeHttpProxyFetch(config.proxyUrl)
    ) as ConnectionConfig["fetch"];
  }
  return new Connection(config.rpcUrl, connConfig);
}
