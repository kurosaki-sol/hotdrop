import "dotenv/config";
import os from "node:os";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var: ${name}. See .env.example for the full list.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${name}: "${raw}"`);
  }
  return parsed;
}

// Half the logical cores is a safe default — leaves room for the OS and
// other work while still getting most of the mining speedup.
const halfCores = Math.max(2, Math.floor(os.cpus().length / 2));

export const config = {
  // Solana devnet RPC. Override to use Helius/QuickNode/a local validator.
  rpcUrl: process.env.RPC_URL ?? "https://api.devnet.solana.com",

  // Base58 string OR JSON array (Solana CLI format, e.g. `[12,34,...]`).
  // This wallet pays tx fees and receives all claimed SOL.
  mainWalletSecret: required("MAIN_WALLET_SECRET"),

  // Optional residential/datacenter proxy to bypass devnet RPC rate limits.
  // Supports http://, https://, socks4://, socks5://.
  // If unset, requests go directly from your IP and you'll hit 429s sooner.
  proxyUrl: optional("PROXY_URL"),

  // How many claims run in parallel. Each one mines a keypair + submits a tx.
  // Higher = more throughput but more 429s. 2–4 without proxy, 6–8 with proxy.
  pipelines: num("POW_PIPELINES", 3),

  // Mining threads per pipeline. Total CPU usage ≈ pipelines × workersPerPipeline.
  workersPerPipeline: num("POW_WORKERS_PER_PIPELINE", Math.max(1, Math.floor(halfCores / 3))),

  // Hard cap on the mining difficulty we'll accept from a discovered faucet.
  // Difficulty N means we need a pubkey starting with N consecutive 'A's in base58.
  // Each +1 = 58× more tries. 3 ≈ <1s, 4 ≈ ~3s, 5 ≈ ~2min, 6 ≈ ~2h with 8 workers.
  maxDifficulty: num("MAX_DIFFICULTY", 4),

  // How many claims per batch, and pause between batches (ms).
  // Pausing lets the RPC rate-limit window reset between runs.
  batchSize: num("BATCH_SIZE", 50),
  batchSleepMs: num("BATCH_SLEEP_MS", 30_000),

  // Optional HTTP distribution API. If both are set, a `POST /distribute`
  // endpoint starts up. If either is missing, no HTTP server is exposed.
  apiToken: optional("API_TOKEN"),
  apiPort: num("API_PORT", 3000),

  // Safety cap on the `sol` parameter of /distribute.
  maxDistributeSol: num("MAX_DISTRIBUTE_SOL", 5),
};

export const hasApi = Boolean(config.apiToken);
