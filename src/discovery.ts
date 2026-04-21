import type { Connection } from "@solana/web3.js";
import { log } from "./logger.js";
import {
  POW_PROGRAM_ID,
  SPEC_DATA_SIZE,
  decodeSpec,
  type FaucetSpec,
} from "./program.js";

// A faucet we can actually claim from: the spec (parameters) + the source
// account balance, plus a derived `claimsRemaining` for planning.
export interface LiveFaucet extends FaucetSpec {
  sourceBalance: bigint;
  claimsRemaining: bigint;
}

// Scan the PoW program for all spec accounts, then fetch each source balance
// to see which ones are actually funded. We filter by exact dataSize (17)
// because that's the only account type the program owns.
export async function discoverFaucets(
  connection: Connection,
  maxDifficulty: number,
): Promise<LiveFaucet[]> {
  const accounts = await connection.getProgramAccounts(POW_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ dataSize: SPEC_DATA_SIZE }],
  });

  const eligibleSpecs = accounts
    .map(({ pubkey, account }) => decodeSpec(pubkey, account.data as Buffer))
    .filter((s) => s.difficulty > 0 && s.difficulty <= maxDifficulty && s.amount > 0n);

  log.info("faucets discovered", {
    total: accounts.length,
    eligible: eligibleSpecs.length,
    maxDifficulty,
  });

  if (eligibleSpecs.length === 0) return [];

  // Fan out the balance lookups in parallel.
  const balances = await Promise.all(
    eligibleSpecs.map((s) => connection.getBalance(s.sourcePubkey, "confirmed")),
  );

  const live: LiveFaucet[] = [];
  eligibleSpecs.forEach((spec, i) => {
    const balance = BigInt(balances[i]!);
    // Require at least one full claim's worth of reserve — no point mining
    // for a spec whose `source` can't actually pay out.
    if (balance >= spec.amount) {
      live.push({
        ...spec,
        sourceBalance: balance,
        claimsRemaining: balance / spec.amount,
      });
    }
  });

  // Sort by return-per-attempt: higher amount per unit of mining work first.
  // This makes the planner naturally prefer diff-3-big-reward over diff-4-small.
  live.sort((a, b) => {
    const aRatio = Number(a.amount) / Math.pow(58, a.difficulty);
    const bRatio = Number(b.amount) / Math.pow(58, b.difficulty);
    return bRatio - aRatio;
  });

  log.info("faucets live", {
    count: live.length,
    top: live.slice(0, 5).map((f) => ({
      spec: f.specPubkey.toBase58(),
      diff: f.difficulty,
      amountSol: Number(f.amount) / 1e9,
      reserveSol: Number(f.sourceBalance) / 1e9,
    })),
  });

  return live;
}
