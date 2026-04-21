import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { loadMainWallet } from "./wallet.js";
import { makeConnection } from "./connection.js";
import { discoverFaucets, type LiveFaucet } from "./discovery.js";
import { mine } from "./miner.js";
import { AIRDROP_DISCRIMINATOR, POW_PROGRAM_ID, deriveReceipt } from "./program.js";

// Network timeouts. We prefer short timeouts + retries over long hangs —
// if the RPC or proxy is slow, we'd rather abandon and try another faucet
// than block a pipeline for minutes.
const BLOCKHASH_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 15_000;
const CONFIRM_TIMEOUT_MS = 60_000;
const MAX_SEND_ATTEMPTS = 3;

export interface ClaimResult {
  spec: string;
  signature: string | null;
  lamports: bigint;
  success: boolean;
  error?: string;
}

const connection: Connection = makeConnection();

// Build the raw `airdrop` instruction. We don't use @coral-xyz/anchor — it
// would pull in a ~2MB framework dep for literally one 8-byte discriminator.
function buildAirdropIx(
  payer: PublicKey,
  signer: PublicKey,
  receipt: PublicKey,
  faucet: LiveFaucet,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: POW_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: receipt, isSigner: false, isWritable: true },
      { pubkey: faucet.specPubkey, isSigner: false, isWritable: false },
      { pubkey: faucet.sourcePubkey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: AIRDROP_DISCRIMINATOR,
  });
}

// Race any promise against a hard deadline so a stuck proxy or RPC doesn't
// freeze a whole pipeline.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

// Send + confirm a signed tx with bounded retries. We only retry on 429
// (rate limit) and blockhash expiry — every other error is either permanent
// or signals a bug elsewhere, so bailing fast is better.
async function sendAndConfirm(
  payer: Keypair,
  signer: Keypair,
  ix: TransactionInstruction,
): Promise<string> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await withTimeout(
        connection.getLatestBlockhash("confirmed"),
        BLOCKHASH_TIMEOUT_MS,
        "getLatestBlockhash",
      );
      const tx = new Transaction({
        feePayer: payer.publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(ix);
      tx.sign(payer, signer);
      const raw = tx.serialize();

      const signature = await withTimeout(
        connection.sendRawTransaction(raw, {
          skipPreflight: true, // we already know the tx is well-formed
          maxRetries: 0, // we handle retries ourselves
        }),
        SEND_TIMEOUT_MS,
        "sendRawTransaction",
      );

      const result = await withTimeout(
        connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed",
        ),
        CONFIRM_TIMEOUT_MS,
        "confirmTransaction",
      );
      if (result.value.err) {
        throw new Error(`tx failed: ${JSON.stringify(result.value.err)}`);
      }
      return signature;
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message;
      const isRetryable = msg.includes("429") || msg.includes("blockhash");
      if (!isRetryable) break;
      // Linear backoff: 400ms, 800ms, 1200ms.
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("send failed with no error");
}

async function claimOne(
  payer: Keypair,
  faucet: LiveFaucet,
): Promise<ClaimResult> {
  const specStr = faucet.specPubkey.toBase58();
  try {
    const { keypair: signer } = await mine(
      faucet.difficulty,
      config.workersPerPipeline,
    );
    const receipt = deriveReceipt(signer.publicKey, faucet.difficulty);
    const ix = buildAirdropIx(payer.publicKey, signer.publicKey, receipt, faucet);
    const signature = await sendAndConfirm(payer, signer, ix);
    log.info("airdrop claimed", {
      spec: specStr,
      signature,
      amountSol: Number(faucet.amount) / 1e9,
    });
    return { spec: specStr, signature, lamports: faucet.amount, success: true };
  } catch (err) {
    const msg = (err as Error).message;
    log.warn("claim failed", { spec: specStr, err: msg });
    return {
      spec: specStr,
      signature: null,
      lamports: 0n,
      success: false,
      error: msg,
    };
  }
}

// Errors that suggest the faucet has been drained or its state has changed in
// a way that makes further claims pointless. We abort the cycle early in that
// case to avoid burning a whole batch against a dead faucet.
function looksLikeDrainedFaucet(error: string): boolean {
  return (
    error.includes("insufficient") ||
    error.includes("custom program error") ||
    error.includes("Account does not exist")
  );
}

// Run one farming cycle: discover funded faucets, plan up to `maxClaims`
// jobs across them, then claim in parallel with `config.pipelines` workers.
export async function runCycle(maxClaims: number): Promise<ClaimResult[]> {
  const payer = loadMainWallet();
  const faucets = await discoverFaucets(connection, config.maxDifficulty);
  if (faucets.length === 0) {
    log.warn("no faucets available", { maxDifficulty: config.maxDifficulty });
    return [];
  }

  // Build the work queue, capped by each faucet's remaining claims and by
  // the overall cycle budget.
  const jobs: LiveFaucet[] = [];
  let remaining = maxClaims;
  for (const faucet of faucets) {
    if (remaining <= 0) break;
    const fromThis = Number(
      faucet.claimsRemaining < BigInt(remaining)
        ? faucet.claimsRemaining
        : BigInt(remaining),
    );
    for (let i = 0; i < fromThis; i++) jobs.push(faucet);
    remaining -= fromThis;
  }

  log.info("cycle starting", {
    jobs: jobs.length,
    pipelines: config.pipelines,
    workersPerPipeline: config.workersPerPipeline,
  });

  const results: ClaimResult[] = [];
  let cursor = 0;
  let aborted = false;

  // Each pipeline pulls jobs from a shared queue (just an index). Short,
  // simple, no external queue library needed.
  const runPipeline = async (): Promise<void> => {
    while (!aborted) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const result = await claimOne(payer, jobs[i]!);
      results.push(result);
      if (!result.success && looksLikeDrainedFaucet(result.error ?? "")) {
        log.warn("faucet likely drained, stopping cycle early", {
          spec: result.spec,
        });
        aborted = true;
        return;
      }
    }
  };

  const pipelines = Array.from(
    { length: Math.min(config.pipelines, jobs.length) },
    runPipeline,
  );
  await Promise.all(pipelines);

  const ok = results.filter((r) => r.success).length;
  const totalLamports = results
    .filter((r) => r.success)
    .reduce((sum, r) => sum + r.lamports, 0n);
  log.info("cycle done", {
    ok,
    failed: results.length - ok,
    totalSol: Number(totalLamports) / 1e9,
  });
  return results;
}
