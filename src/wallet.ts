import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config.js";

// Accepts either a base58 string (what `solana-keygen pubkey` shows for secrets
// stored that way) or a JSON array of 64 bytes (what `solana-keygen new`
// writes to ~/.config/solana/id.json).
export function loadMainWallet(): Keypair {
  const raw = config.mainWalletSecret.trim();
  try {
    if (raw.startsWith("[")) {
      const bytes = JSON.parse(raw) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    }
    return Keypair.fromSecretKey(bs58.decode(raw));
  } catch (err) {
    throw new Error(
      `MAIN_WALLET_SECRET must be a base58 string or JSON array of 64 bytes. ` +
        `Parse error: ${(err as Error).message}`,
    );
  }
}
