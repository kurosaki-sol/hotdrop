// Unified CLI. Usage:
//
//   hotdrop farm                     — run the continuous loop (farm forever)
//   hotdrop claim [count]            — one-shot: claim N times then exit (default 20)
//   hotdrop discover                 — list all live faucets and exit
//   hotdrop distribute <dest> <sol>  — send SOL from main wallet to <dest>
//   hotdrop balance                  — print main wallet balance
//   hotdrop serve                    — start API only (no farming)
//
// All commands read config from .env / env vars (see .env.example).

import { PublicKey } from "@solana/web3.js";
import { log } from "./logger.js";
import { runCycle } from "./claimer.js";
import { farm } from "./farm.js";
import { discoverFaucets } from "./discovery.js";
import { distribute } from "./distributor.js";
import { makeConnection } from "./connection.js";
import { loadMainWallet } from "./wallet.js";
import { config } from "./config.js";
import { startApi } from "./api.js";

async function cmdFarm(): Promise<void> {
  await farm();
}

async function cmdClaim(args: string[]): Promise<void> {
  const count = Number(args[0] ?? 20);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`invalid count: "${args[0]}"`);
  }
  const results = await runCycle(count);
  const ok = results.filter((r) => r.success).length;
  const totalSol = results
    .filter((r) => r.success)
    .reduce((s, r) => s + Number(r.lamports) / 1e9, 0);
  log.info("claim complete", { ok, failed: results.length - ok, totalSol });
}

async function cmdDiscover(): Promise<void> {
  const connection = makeConnection();
  const faucets = await discoverFaucets(connection, config.maxDifficulty);
  if (faucets.length === 0) {
    console.log("No live faucets found (check MAX_DIFFICULTY in .env).");
    return;
  }
  console.log(
    ["DIFF", "AMOUNT_SOL", "RESERVE_SOL", "CLAIMS_LEFT", "SPEC"]
      .map((h) => h.padEnd(14))
      .join(""),
  );
  for (const f of faucets) {
    console.log(
      [
        String(f.difficulty),
        (Number(f.amount) / 1e9).toFixed(6),
        (Number(f.sourceBalance) / 1e9).toFixed(4),
        String(f.claimsRemaining),
        f.specPubkey.toBase58(),
      ]
        .map((c, i) => (i < 4 ? c.padEnd(14) : c))
        .join(""),
    );
  }
}

async function cmdDistribute(args: string[]): Promise<void> {
  const [destination, solStr] = args;
  if (!destination || !solStr) {
    throw new Error("usage: hotdrop distribute <destination_pubkey> <sol>");
  }
  new PublicKey(destination); // validate early
  const sol = Number(solStr);
  if (!Number.isFinite(sol) || sol <= 0) {
    throw new Error(`invalid sol amount: "${solStr}"`);
  }
  const result = await distribute(destination, sol);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdBalance(): Promise<void> {
  const connection = makeConnection();
  const wallet = loadMainWallet();
  const lamports = await connection.getBalance(wallet.publicKey, "confirmed");
  console.log(
    `main wallet: ${wallet.publicKey.toBase58()}\n` +
      `balance:     ${(lamports / 1e9).toFixed(6)} SOL (${lamports} lamports)`,
  );
}

async function cmdServe(): Promise<void> {
  if (!config.apiToken) {
    throw new Error("cannot serve API without API_TOKEN set in .env");
  }
  await startApi();
  // Keep alive — fastify runs in background, we just need to not exit.
  await new Promise(() => {});
}

function printUsage(): void {
  console.log(
    [
      "Usage: hotdrop <command> [args]",
      "",
      "Commands:",
      "  farm                      run the farming loop (keeps running, Ctrl+C to stop)",
      "  claim [count]             one-shot claim cycle (default count: 20)",
      "  discover                  list all live faucets",
      "  distribute <dest> <sol>   transfer SOL from main wallet to <dest>",
      "  balance                   show main wallet balance",
      "  serve                     start the distribution API (no farming)",
      "",
      "Config via .env — see .env.example for all variables.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  switch (command) {
    case "farm":
      return cmdFarm();
    case "claim":
      return cmdClaim(args);
    case "discover":
      return cmdDiscover();
    case "distribute":
      return cmdDistribute(args);
    case "balance":
      return cmdBalance();
    case "serve":
      return cmdServe();
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error((err as Error).message);
    process.exit(1);
  },
);
