import { PublicKey } from "@solana/web3.js";

// The on-chain proof-of-work faucet program by Jarry Xiao.
// Source: https://github.com/jarry-xiao/proof-of-work-faucet
// Deployed on Solana devnet at this address.
export const POW_PROGRAM_ID = new PublicKey(
  "PoWSNH2hEZogtCg1Zgm51FnkmJperzYDgPK4fvs8taL",
);

// The `Difficulty` Anchor account stores a u8 difficulty + a u64 amount.
// 8 bytes of Anchor discriminator + 1 + 8 = 17 bytes total.
// We use this size as a filter in getProgramAccounts() to find spec accounts.
export const SPEC_DATA_SIZE = 17;

// First 8 bytes of sha256("global:airdrop") — Anchor's instruction selector.
// We build the instruction manually (without the Anchor client) to avoid
// pulling in the whole framework as a dependency.
export const AIRDROP_DISCRIMINATOR = Buffer.from("71ad24ee26981675", "hex");

export interface FaucetSpec {
  specPubkey: PublicKey;
  sourcePubkey: PublicKey;
  difficulty: number;
  amount: bigint;
}

// Decode a `Difficulty` account and derive its companion `source` PDA.
// The source holds the actual SOL that gets distributed on each claim.
export function decodeSpec(pubkey: PublicKey, data: Buffer): FaucetSpec {
  const difficulty = data.readUInt8(8);
  const amount = data.readBigUInt64LE(9);
  const [sourcePubkey] = PublicKey.findProgramAddressSync(
    [Buffer.from("source"), pubkey.toBuffer()],
    POW_PROGRAM_ID,
  );
  return { specPubkey: pubkey, sourcePubkey, difficulty, amount };
}

// `receipt` PDA prevents the same (vanity_keypair, difficulty) pair from
// claiming twice — once created, the program refuses to re-airdrop to it.
// This is why every claim needs a fresh mined keypair.
export function deriveReceipt(signer: PublicKey, difficulty: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), signer.toBuffer(), Buffer.from([difficulty])],
    POW_PROGRAM_ID,
  );
  return pda;
}
