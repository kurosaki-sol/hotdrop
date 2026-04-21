import {
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { log } from "./logger.js";
import { loadMainWallet } from "./wallet.js";
import { makeConnection } from "./connection.js";
import {
  CREATE_DISCRIMINATOR,
  POW_PROGRAM_ID,
  deriveSpec,
  u64ToLe,
} from "./program.js";

// Why this command exists:
//
// Every claim hotdrop makes drains SOL from a faucet someone else funded.
// Long-term that's not sustainable — the ecosystem needs more people
// *seeding* faucets than draining them. `create-faucet` lets you give back
// by deploying a new faucet spec and funding it with devnet SOL you've
// accumulated (or freshly airdropped from the official faucet).
//
// Once created, your faucet is public. Anyone running `hotdrop discover`
// (or the upstream `devnet-pow` CLI) will see it and can claim from it.
// You cannot close it or reclaim the SOL — it's a one-way gift to the
// community. Treat it like a small, permanent donation.

export interface CreateFaucetResult {
  specPubkey: string;
  sourcePubkey: string;
  createSignature: string;
  fundSignature: string | null;
  fundedSol: number;
}

// Build the `create` instruction. Args are packed as Anchor expects:
// 8-byte discriminator + 1-byte difficulty + 8-byte amount (little-endian).
function buildCreateIx(
  payer: import("@solana/web3.js").PublicKey,
  specPubkey: import("@solana/web3.js").PublicKey,
  difficulty: number,
  amountLamports: bigint,
): TransactionInstruction {
  const data = Buffer.concat([
    CREATE_DISCRIMINATOR,
    Buffer.from([difficulty]),
    u64ToLe(amountLamports),
  ]);
  return new TransactionInstruction({
    programId: POW_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: specPubkey, isSigner: false, isWritable: true },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ],
    data,
  });
}

export async function createFaucet(
  difficulty: number,
  amountSol: number,
  initialFundingSol: number,
): Promise<CreateFaucetResult> {
  if (difficulty < 1 || difficulty > 8 || !Number.isInteger(difficulty)) {
    throw new Error(`difficulty must be an integer between 1 and 8 (got ${difficulty})`);
  }
  if (amountSol <= 0) {
    throw new Error(`amountSol must be > 0 (got ${amountSol})`);
  }
  if (initialFundingSol < 0) {
    throw new Error(`initialFundingSol must be >= 0 (got ${initialFundingSol})`);
  }

  const amountLamports = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));
  const fundingLamports = Math.floor(initialFundingSol * LAMPORTS_PER_SOL);

  const connection = makeConnection();
  const payer = loadMainWallet();
  const { specPubkey, sourcePubkey } = deriveSpec(difficulty, amountLamports);

  // Sanity check: refuse to create if a spec with these exact params already
  // exists. The program would throw anyway (PDA collision), but surfacing
  // the error here gives a clearer message + tells the user what's there.
  const existing = await connection.getAccountInfo(specPubkey, "confirmed");
  if (existing) {
    throw new Error(
      `A spec already exists for (difficulty=${difficulty}, amount=${amountSol} SOL) ` +
        `at ${specPubkey.toBase58()}. Pick a different amount (even 0.0000001 SOL off) ` +
        `to get a unique PDA.`,
    );
  }

  log.info("creating faucet", {
    difficulty,
    amountSol,
    initialFundingSol,
    specPubkey: specPubkey.toBase58(),
    sourcePubkey: sourcePubkey.toBase58(),
  });

  // Step 1: call `create` to register the spec. This allocates the 17-byte
  // Difficulty account and stores (difficulty, amount). The `source` PDA
  // associated with this spec doesn't exist as an account yet — it's just
  // an address. The next `airdrop` against this spec will implicitly credit
  // it (or we fund it ourselves in step 2).
  const createIx = buildCreateIx(
    payer.publicKey,
    specPubkey,
    difficulty,
    amountLamports,
  );
  const createTx = new Transaction().add(createIx);
  const createSignature = await sendAndConfirmTransaction(
    connection,
    createTx,
    [payer],
    { commitment: "confirmed" },
  );
  log.info("faucet spec created", { signature: createSignature });

  // Step 2: fund the source PDA with an initial donation. Skippable with
  // initialFundingSol=0 if the user wants to deploy the spec first and send
  // funds later (or in multiple chunks). A source with 0 lamports means the
  // faucet exists but claimers just get 0 SOL — harmless but useless.
  let fundSignature: string | null = null;
  if (fundingLamports > 0) {
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: sourcePubkey,
        lamports: fundingLamports,
      }),
    );
    fundSignature = await sendAndConfirmTransaction(connection, fundTx, [payer], {
      commitment: "confirmed",
    });
    log.info("faucet funded", {
      signature: fundSignature,
      amountSol: initialFundingSol,
      sourcePubkey: sourcePubkey.toBase58(),
    });
  }

  return {
    specPubkey: specPubkey.toBase58(),
    sourcePubkey: sourcePubkey.toBase58(),
    createSignature,
    fundSignature,
    fundedSol: initialFundingSol,
  };
}
