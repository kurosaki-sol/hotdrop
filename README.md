<div align="center">

![hotdrop banner](assets/banner.jpg)

# hotdrop

**Unstoppable devnet SOL for Solana teams running betas and integration tests.**

Claims from the on-chain proof-of-work faucet so your test users aren't blocked by rate limits, captchas, or GitHub account requirements.

</div>

---

> ### ⚠️ What this is for
>
> Your team is about to launch a **devnet beta** (a new protocol integration, an MPC circuit, an ephemeral rollup, a token launchpad) and you need your early users to actually use it. But `api.devnet.solana.com` is rate-limited and often dry, `faucet.solana.com` requires linking a GitHub account and caps you at [2 requests per 8 hours, 5 SOL max per request](https://faucet.solana.com) with an explicit *"AI agents should not use this faucet"* notice — and deploying even a single Anchor program to devnet commonly burns [1.5–3 SOL at first try, more if a redeploy leaves buffer accounts locked](https://solana.com/docs/programs/deploying). Arcium's MXE deployment alone asks for [2–5 SOL up front](https://docs.arcium.com/developers/deployment), and MagicBlock ephemeral rollup programs pay standard Solana BPF loader rent on top of whatever your app needs.
>
> Sending every tester through the official faucet does not work. This tool farms devnet SOL via [Jarry Xiao's on-chain PoW faucet](https://github.com/jarry-xiao/proof-of-work-faucet) so **your team can fund its own distribution** — no rate limits, no accounts required, no humans in the loop.
>
> **This is a devnet utility for testing.** Do not point it at mainnet.

---

## Credit where it's due

The heavy lifting is done by a smart contract we did not write:

- **On-chain program:** [`jarry-xiao/proof-of-work-faucet`](https://github.com/jarry-xiao/proof-of-work-faucet) (program ID `PoWSNH2hEZogtCg1Zgm51FnkmJperzYDgPK4fvs8taL` on devnet)
- **Original author:** [Jarry Xiao](https://x.com/jarxiao) — co-founder of Ellipsis Labs, creator of the Phoenix orderbook on Solana
- **Reference CLI:** `cargo install devnet-pow` ([crate](https://crates.io/crates/devnet-pow))

`hotdrop` is a TypeScript client on top of that program with opinionated choices for team-scale automation: parallel mining, a distribution API, proxy-friendly RPC, and a farming loop.

## How it works

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#1a1a1a','primaryTextColor':'#fff','primaryBorderColor':'#9945FF','lineColor':'#14F195','secondaryColor':'#2a2a2a','tertiaryColor':'#1a1a1a'}}}%%
flowchart LR
    MW["🔑 main wallet<br/>(pays fees, receives SOL)"]

    subgraph HOTDROP ["your machine — hotdrop runner"]
        direction TB
        M1["⛏ miner #1<br/>grinding AAA..."]
        M2["⛏ miner #2<br/>grinding AAA..."]
        M3["⛏ miner #N<br/>grinding AAA..."]
    end

    PROXY{{"🌐 optional proxy<br/>rotates outbound IP"}}
    RPC[["☁ devnet RPC<br/>api.devnet.solana.com"]]
    PROG["📜 PoW program<br/>PoWSNH2...taL"]

    MW -->|signs airdrop tx| HOTDROP
    HOTDROP -->|signed tx| PROXY
    PROXY -->|JSON-RPC| RPC
    RPC -->|invoke| PROG
    PROG -->|transfer SOL| MW

    classDef wallet fill:#9945FF20,stroke:#9945FF,color:#fff,stroke-width:2px
    classDef miner fill:#14F19520,stroke:#14F195,color:#fff
    classDef chain fill:#1a1a1a,stroke:#666,color:#fff
    class MW wallet
    class M1,M2,M3 miner
    class RPC,PROG,PROXY chain
```

1. **Discover** — scan the PoW program on devnet for every faucet account that still has SOL to distribute (`hotdrop discover`)
2. **Mine** — in parallel, brute-force ed25519 keypairs whose base58 pubkey starts with N consecutive `A` characters (N = the faucet's difficulty)
3. **Claim** — submit a signed `airdrop` instruction where the vanity keypair co-signs; the on-chain program verifies the prefix and transfers SOL into your main wallet
4. **Distribute** — either pull SOL from the main wallet via the optional HTTP API, or transfer it yourself in whatever backend you already have

### Where `hotdrop` fits in your stack

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#1a1a1a','primaryTextColor':'#fff','primaryBorderColor':'#9945FF','lineColor':'#14F195'}}}%%
flowchart LR
    U(["👥 beta testers"])

    subgraph YOURAPP ["your beta app"]
        FE["frontend<br/>'claim airdrop' button"]
        BE["backend<br/>or cloud function"]
    end

    subgraph INFRA ["your infra (anywhere)"]
        HD["🎯 hotdrop<br/>farming loop"]
        W["💰 funded wallet<br/>MAIN_WALLET"]
    end

    DEV[["☁ solana devnet"]]

    U -->|clicks claim| FE
    FE -->|request SOL| BE
    BE -->|transfer SOL to user| W
    HD -->|keeps refilling| W
    HD <-->|mines + claims| DEV

    classDef wallet fill:#9945FF20,stroke:#9945FF,color:#fff,stroke-width:2px
    classDef tool fill:#14F19520,stroke:#14F195,color:#fff
    class W wallet
    class HD tool
```

The runner (`hotdrop farm`) is decoupled from your app — it just maintains a balance in a wallet you control. Your backend then distributes from that wallet using whatever logic you want (per-user caps, whitelists, rate limits, etc.). No coupling, no lock-in.

The only "cost" is CPU time. There are no rate limits, no external services required, and no single point of failure aside from the faucet itself running dry — in which case any Solana dev with spare devnet SOL can refill it for the whole community.

## Quickstart

```bash
git clone https://github.com/YOUR_USER/hotdrop.git
cd hotdrop
npm install
cp .env.example .env
# edit .env → at minimum, set MAIN_WALLET_SECRET
npm run dev
```

Your main wallet needs a tiny amount of devnet SOL to pay fees on the first few claims (~0.01 SOL). Bootstrap it once through [faucet.solana.com](https://faucet.solana.com) or `solana airdrop 1 <pubkey> --url devnet`; after that `hotdrop` sustains itself.

## Two ways to run

Pick the shape that fits your team's infra.

### A. Farm-only (most teams)

Your backend already holds a wallet and knows how to distribute SOL to users. `hotdrop` just tops up a wallet you control. No HTTP surface exposed.

```bash
# .env — no API_TOKEN set
MAIN_WALLET_SECRET=<the wallet your backend owns>
POW_PIPELINES=3

npm run farm
```

Your backend reads the wallet balance, transfers SOL to users on demand. This is what the author's team uses internally.

### B. Farm + API (zero-backend integration)

Your beta app calls `POST /distribute` directly from a trusted service. `hotdrop` holds the wallet and exposes a bearer-authenticated endpoint.

```bash
# .env
MAIN_WALLET_SECRET=<a wallet you set aside for distribution>
API_TOKEN=$(openssl rand -hex 32)
POW_PIPELINES=3

npm run dev  # starts farming + API on $API_PORT (default 3000)
```

Your backend calls:

```bash
curl -X POST http://localhost:3000/distribute \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "destination": "<user_pubkey>", "sol": 0.5 }'
```

**Do not expose the API to the open internet without TLS + rate limiting in front.** It's a convenience for trusted callers, not a public service.

## CLI

```bash
hotdrop farm                     # run the farming loop (Ctrl+C to stop)
hotdrop claim [count]            # one-shot: claim N times then exit (default 20)
hotdrop discover                 # list all live faucets with their reserves
hotdrop distribute <dest> <sol>  # one-off transfer from main wallet
hotdrop balance                  # show main wallet balance
hotdrop serve                    # start the distribution API, no farming
```

All commands read config from `.env`.

## Why a proxy?

`api.devnet.solana.com` rate-limits by source IP. Each claim hits the RPC three times (getLatestBlockhash, sendTransaction, confirmTransaction), so even with 4 parallel pipelines you'll see `429 Too Many Requests` within a minute.

If you set `PROXY_URL` to a rotating residential proxy (or any proxy that swaps the outbound IP per request), the per-IP rate limit stops mattering and you can comfortably run 6-8 pipelines. Without a proxy, keep `POW_PIPELINES` low (2-3) and the loop will still farm steadily, it just ramps up more slowly.

Both HTTP and SOCKS4/5 proxies work — just put the full URL in `PROXY_URL`.

## Performance

Observed on a Ryzen 9 (16 threads), farming difficulty 3 at 0.02 SOL per claim:

| Setup | SOL / hour |
| --- | --- |
| No proxy, 2 pipelines × 3 workers | ~25 |
| Residential proxy, 4 pipelines × 3 workers | ~50 |
| Residential proxy, 6 pipelines × 3 workers | ~80+ (watch for 429s) |

You're bottlenecked by **RPC latency**, not CPU. The mining itself (diff 3) takes under a second; the Solana confirmation round-trip dominates. Spending CPU on diff 4/5 only makes sense if you find a faucet offering a proportionally bigger reward — most of the time diff 3 at 0.02 SOL wins on throughput.

## Safety

Short summary of the security audit we ran on the PoW program:

- **No rug path.** SOL leaves the faucet only via the `airdrop` instruction, and that instruction always transfers to the `payer` (your main wallet). The source PDA is program-owned — the faucet creator has no mechanism to claw back SOL after it's been transferred.
- **No spec mutation.** `Difficulty` accounts are `init`-only. A faucet's `(difficulty, amount)` cannot be changed after creation.
- **Receipt replay protection.** Each `(signer_pubkey, difficulty)` pair can only claim once. We mine a fresh keypair per claim, so this is transparent.
- **Small honeypot risk.** A malicious creator can register a spec with a huge `amount` whose `source` is empty — you'd pay ~0.0009 SOL of rent for the `receipt` account and receive 0 SOL. Mitigated by [`discovery.ts`](src/discovery.ts) only returning faucets whose reserve covers at least one full claim.
- **Cap on difficulty.** `MAX_DIFFICULTY` protects against specs that would ask for impossibly expensive mining (diff 8+ = hours of CPU for nothing).

## Alternatives considered

- **Rotating `requestAirdrop` via proxies** — works for a few hours, then the faucet goes dry for everyone regardless of IP. Brittle. (An earlier version of this repo did exactly that; it's why we moved to PoW.)
- **Multiple GitHub-linked accounts on `faucet.solana.com`** — violates their ToS and the website says "AI agents should not use this faucet". Also caps out at [2 req / 8h per account](https://faucet.solana.com).
- **Paid RPC provider faucets** — [Helius's devnet faucet requires a paid plan](https://www.helius.dev/docs/rpc/devnet-sol) and caps at ~1 SOL/day even then. [QuickNode](https://faucet.quicknode.com/solana/devnet) offers one drip per 12h. Fine as a seed, not as a sustained source.
- **Running a local validator** — great for unit tests, useless if your beta is on the real devnet and your users' wallets need real devnet SOL.

PoW faucet ends up being the only approach that's both ToS-safe and automation-friendly.

## Configuration reference

See [`.env.example`](.env.example) for the full list. The short version:

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `MAIN_WALLET_SECRET` | yes | — | base58 or JSON-array secret key |
| `RPC_URL` | no | devnet | any Solana RPC |
| `PROXY_URL` | no | — | http/socks4/socks5 for bypassing per-IP limits |
| `POW_PIPELINES` | no | 3 | parallel claims |
| `POW_WORKERS_PER_PIPELINE` | no | 3 | CPU threads per pipeline |
| `MAX_DIFFICULTY` | no | 4 | hardest faucet difficulty we'll try |
| `BATCH_SIZE` | no | 50 | claims per farming batch |
| `BATCH_SLEEP_MS` | no | 30000 | pause between batches |
| `API_TOKEN` | no | — | set to enable `/distribute` |
| `API_PORT` | no | 3000 | HTTP port if API enabled |
| `MAX_DISTRIBUTE_SOL` | no | 5 | safety cap per `/distribute` call |

## Project layout

```
src/
├── cli.ts           # `hotdrop <command>` dispatcher
├── index.ts         # `npm run dev` entry — API + farm loop
├── config.ts        # env var parsing
├── wallet.ts        # main wallet loading
├── connection.ts    # Solana RPC, optionally tunneled through a proxy
├── program.ts       # PoW program constants + PDA derivations
├── discovery.ts     # scan for funded faucets
├── miner.ts         # vanity keypair mining (worker threads)
├── mine-worker.ts   # the per-thread mining loop
├── claimer.ts       # mine + submit + confirm one claim; runCycle
├── distributor.ts   # transfer SOL from main wallet
├── api.ts           # optional HTTP /distribute
├── farm.ts          # continuous farming loop with stats
└── logger.ts        # structured JSON log lines
```

## License

MIT. Fork it, ship it, put your name on it. Attribution to [Jarry Xiao](https://github.com/jarry-xiao/proof-of-work-faucet) for the on-chain program is the right thing to do either way.

## Contributing

PRs welcome. Good first issues:

- A ready-made Dockerfile
- GitHub Actions CI that runs `tsc --noEmit` + a smoke test
- Benchmarks against a Rust/napi-rs native miner
- A `hotdrop create-faucet` command that lets users *fund* a new PoW spec and give back to the community
