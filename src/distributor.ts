import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { log } from "./logger.js";
import { loadMainWallet } from "./wallet.js";
import { makeConnection } from "./connection.js";

// A small reserve so we never empty the main wallet completely — leaves room
// for fees on the outgoing transfer itself plus any concurrent distributions.
const FEE_RESERVE_LAMPORTS = 10_000;

export interface DistributeResult {
  signature: string;
  lamports: number;
}

const connection = makeConnection();

// Transfer SOL from the main (farmed) wallet to any destination.
// Used by the HTTP API (api.ts) and by the `distribute` CLI command.
export async function distribute(
  destination: string,
  sol: number,
): Promise<DistributeResult> {
  const payer = loadMainWallet();
  const toPubkey = new PublicKey(destination);
  const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
  if (lamports <= 0) throw new Error("sol amount must be > 0");

  const balance = await connection.getBalance(payer.publicKey, "confirmed");
  if (balance < lamports + FEE_RESERVE_LAMPORTS) {
    throw new Error(
      `main wallet has ${balance} lamports (~${(balance / 1e9).toFixed(4)} SOL), ` +
        `need ${lamports + FEE_RESERVE_LAMPORTS} for this transfer + fees`,
    );
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey,
      lamports,
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  log.info("distributed", {
    destination,
    amountSol: sol,
    signature,
  });
  return { signature, lamports };
}
