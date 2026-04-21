import { Worker } from "node:worker_threads";
import { generateKeyPairSync } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { log } from "./logger.js";

// Anatomy of the "mining":
// - The on-chain program checks that `signer.pubkey.base58().starts_with("A" * N)`.
// - We brute-force keypairs until one's pubkey starts with the right prefix.
// - Expected tries ≈ 58^N (size of base58 alphabet raised to difficulty).
// - Diff 3 ≈ 195k tries (<1s). Diff 4 ≈ 11M (~3s). Diff 5 ≈ 656M (~2min).

const SPKI_PUB_OFFSET = 12;
const PKCS8_SEED_OFFSET = 16;

// If mining takes longer than this, we abandon the faucet and move on —
// prevents a stuck or impossibly-difficult spec from blocking a whole pipeline.
const MINING_HARD_TIMEOUT_MS = 120_000;

export interface MineResult {
  keypair: Keypair;
  tries: number;
  elapsedMs: number;
  difficulty: number;
}

interface WorkerFoundMessage {
  type: "found";
  secretKey: number[];
  pubkey: string;
  difficulty: number;
  tries: number;
}
interface WorkerProgressMessage {
  type: "progress";
  tries: number;
}
type WorkerMessage = WorkerFoundMessage | WorkerProgressMessage;

// Single-threaded fallback for trivial difficulties — spinning up worker
// threads costs ~50ms which isn't worth it for diff ≤ 2.
export function mineSync(minDifficulty: number): MineResult {
  const start = Date.now();
  let tries = 0;
  while (true) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    tries++;
    const pub = publicKey
      .export({ format: "der", type: "spki" })
      .subarray(SPKI_PUB_OFFSET);
    const b58 = bs58.encode(pub);
    let prefix = 0;
    while (prefix < b58.length && b58.charCodeAt(prefix) === 65) prefix++;
    if (prefix >= minDifficulty) {
      const seed = privateKey
        .export({ format: "der", type: "pkcs8" })
        .subarray(PKCS8_SEED_OFFSET);
      const secret = Buffer.alloc(64);
      seed.copy(secret, 0);
      pub.copy(secret, 32);
      return {
        keypair: Keypair.fromSecretKey(new Uint8Array(secret)),
        tries,
        elapsedMs: Date.now() - start,
        difficulty: prefix,
      };
    }
  }
}

function workerScriptUrl(): URL {
  const here = dirname(fileURLToPath(import.meta.url));
  return new URL(`file://${resolve(here, "mine-worker.ts")}`);
}

// Main entry: parallel mining across N worker threads. First one to find a
// valid keypair wins, the rest are terminated.
export async function mine(
  minDifficulty: number,
  numWorkers: number,
): Promise<MineResult> {
  if (minDifficulty <= 2) {
    const result = mineSync(minDifficulty);
    log.info("vanity mined (sync)", {
      pubkey: result.keypair.publicKey.toBase58(),
      difficulty: result.difficulty,
      tries: result.tries,
      elapsedMs: result.elapsedMs,
    });
    return result;
  }

  const start = Date.now();
  const workers: Worker[] = [];
  const triesByWorker: Record<number, number> = {};
  let lastReport = start;

  // If we're running under tsx (TypeScript), preserve the loader for worker
  // children so they can require .ts files too.
  const execArgv = process.execArgv.includes("--import")
    ? process.execArgv
    : [...process.execArgv, "--import", "tsx"];

  return new Promise<MineResult>((resolvePromise, reject) => {
    let settled = false;
    const terminateAll = () => {
      for (const w of workers) void w.terminate().catch(() => {});
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateAll();
      reject(
        new Error(
          `mining timed out after ${MINING_HARD_TIMEOUT_MS}ms — difficulty ${minDifficulty} may be too high for your hardware`,
        ),
      );
    }, MINING_HARD_TIMEOUT_MS);
    timer.unref();

    const sumTries = () =>
      Object.values(triesByWorker).reduce((a, b) => a + b, 0);

    for (let i = 0; i < numWorkers; i++) {
      const worker = new Worker(workerScriptUrl(), {
        workerData: { minDifficulty },
        execArgv,
      });
      const id = i;
      triesByWorker[id] = 0;

      worker.on("message", (msg: WorkerMessage) => {
        if (settled) return;
        if (msg.type === "progress") {
          triesByWorker[id] = msg.tries;
          const now = Date.now();
          if (now - lastReport > 3_000) {
            lastReport = now;
            const sum = sumTries();
            log.info("mining progress", {
              totalTries: sum,
              elapsedMs: now - start,
              triesPerSec: Math.round((sum * 1000) / (now - start)),
              workers: numWorkers,
            });
          }
          return;
        }
        // "found" — we have a winner.
        settled = true;
        clearTimeout(timer);
        terminateAll();
        const kp = Keypair.fromSecretKey(Uint8Array.from(msg.secretKey));
        const elapsedMs = Date.now() - start;
        const total = sumTries() + msg.tries;
        log.info("vanity mined", {
          pubkey: msg.pubkey,
          difficulty: msg.difficulty,
          tries: total,
          elapsedMs,
          triesPerSec: Math.round((total * 1000) / Math.max(elapsedMs, 1)),
          workers: numWorkers,
        });
        resolvePromise({
          keypair: kp,
          tries: total,
          elapsedMs,
          difficulty: msg.difficulty,
        });
      });

      worker.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        terminateAll();
        reject(err);
      });

      workers.push(worker);
    }
  });
}
