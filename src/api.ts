import Fastify from "fastify";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { distribute } from "./distributor.js";
import { log } from "./logger.js";

// Optional HTTP server for distributing farmed SOL to end-users or your backend.
// Gated behind a bearer token — set API_TOKEN to enable, leave unset to skip.
//
// This is an INTEGRATION convenience, not a public-facing service. Don't expose
// this to the open internet without proper rate limiting and TLS. If you
// already have a backend that holds the main wallet key, you can skip the API
// entirely and call `distribute()` from your own code.

export async function startApi(): Promise<void> {
  if (!config.apiToken) {
    log.info("api disabled (set API_TOKEN to enable)");
    return;
  }

  const app = Fastify({ logger: false });

  // Simple bearer auth. Timing-safe comparison is overkill for a devnet tool.
  app.addHook("onRequest", async (req, reply) => {
    const token = req.headers["authorization"]?.toString().replace(/^Bearer\s+/i, "");
    if (token !== config.apiToken) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Body: { destination?: string; sol?: number } }>(
    "/distribute",
    async (req, reply) => {
      const { destination, sol } = req.body ?? {};
      if (!destination || typeof destination !== "string") {
        return reply.code(400).send({ error: "destination (pubkey) required" });
      }
      try {
        new PublicKey(destination);
      } catch {
        return reply.code(400).send({ error: "destination is not a valid pubkey" });
      }
      if (typeof sol !== "number" || sol <= 0 || sol > config.maxDistributeSol) {
        return reply
          .code(400)
          .send({ error: `sol must be a number between 0 and ${config.maxDistributeSol}` });
      }
      try {
        const result = await distribute(destination, sol);
        return reply.send(result);
      } catch (err) {
        const msg = (err as Error).message;
        log.error("distribute failed", { destination, sol, err: msg });
        return reply.code(500).send({ error: msg });
      }
    },
  );

  await app.listen({ port: config.apiPort, host: "0.0.0.0" });
  log.info("api listening", { port: config.apiPort });
}
