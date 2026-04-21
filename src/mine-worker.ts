// Worker thread that grinds ed25519 keypairs until it finds one whose base58
// public key starts with `minDifficulty` consecutive 'A' characters — that's
// the proof of work the on-chain program checks.
//
// Runs inside Node's worker_threads. Spawned by mineVanityKeypair() in miner.ts.

import { parentPort, workerData } from "node:worker_threads";
import { generateKeyPairSync } from "node:crypto";
import bs58 from "bs58";

interface WorkerInput {
  minDifficulty: number;
}

const { minDifficulty } = workerData as WorkerInput;

// Node exports ed25519 keys as DER-encoded structures. The raw 32-byte values
// we need sit at fixed offsets: skip the ASN.1 header, take the last 32 bytes.
const SPKI_PUB_OFFSET = 12; // public key (SPKI = SubjectPublicKeyInfo)
const PKCS8_SEED_OFFSET = 16; // private seed (PKCS#8)

// Solana wallets want a 64-byte secret = seed (32) + pubkey (32).
function buildSolanaSecretKey(pubkey: Buffer, seed: Buffer): Buffer {
  const secret = Buffer.alloc(64);
  seed.copy(secret, 0);
  pubkey.copy(secret, 32);
  return secret;
}

// Report progress roughly every N tries so the main thread can show throughput.
const REPORT_EVERY = 50_000;
let tries = 0;

// Infinite loop; the main thread terminates us when a sibling finds a winner
// or when a hard timeout fires.
while (true) {
  // Native ed25519 via OpenSSL is ~5–10× faster than tweetnacl's JS impl.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  tries++;

  const spki = publicKey.export({ format: "der", type: "spki" });
  const pub = spki.subarray(SPKI_PUB_OFFSET);
  const encoded = bs58.encode(pub);

  let prefix = 0;
  while (prefix < encoded.length && encoded.charCodeAt(prefix) === 65) {
    prefix++;
  }

  if (prefix >= minDifficulty) {
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    const seed = pkcs8.subarray(PKCS8_SEED_OFFSET);
    const secretKey = buildSolanaSecretKey(Buffer.from(pub), Buffer.from(seed));
    parentPort!.postMessage({
      type: "found",
      secretKey: Array.from(secretKey),
      pubkey: encoded,
      difficulty: prefix,
      tries,
    });
    break;
  }

  if (tries % REPORT_EVERY === 0) {
    parentPort!.postMessage({ type: "progress", tries });
  }
}
