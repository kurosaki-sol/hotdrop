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

// First 8 bytes of sha256("global:create"). Used by `hotdrop create-faucet`
// to register a brand-new `(difficulty, amount)` spec on-chain.
export const CREATE_DISCRIMINATOR = Buffer.from("181ec828051c0777", "hex");

// Anchor's `u64::to_le_bytes()` helper — we need this to derive the `spec`
// PDA from (difficulty, amount), matching the seeds in the Rust program.
export function u64ToLe(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return buf;
}

// Derive the `spec` PDA for a given (difficulty, amount). This is what
// `create` will allocate, and it's globally unique per (difficulty, amount)
// pair — two people trying to create the same spec would collide on this PDA.
export function deriveSpec(
  difficulty: number,
  amount: bigint,
): { specPubkey: PublicKey; sourcePubkey: PublicKey } {
  const [specPubkey] = PublicKey.findProgramAddressSync(
    [Buffer.from("spec"), Buffer.from([difficulty]), u64ToLe(amount)],
    POW_PROGRAM_ID,
  );
  const [sourcePubkey] = PublicKey.findProgramAddressSync(
    [Buffer.from("source"), specPubkey.toBuffer()],
    POW_PROGRAM_ID,
  );
  return { specPubkey, sourcePubkey };
}

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
