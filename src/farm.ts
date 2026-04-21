import { config } from "./config.js";
import { log } from "./logger.js";
import { runCycle } from "./claimer.js";

// Continuous farming loop. Runs cycles forever with a pause between each so
// the RPC rate-limit window resets. Graceful shutdown via SIGINT prints
// aggregate stats so you can see the SOL/hour you sustained.

// Hard caps on process-level crashes — a rogue SOCKS node or a transient
// RPC hiccup can emit errors asynchronously, and we don't want to take
// down the whole loop over a single transient failure.
function installCrashGuards(): void {
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception (swallowed)", {
      err: err.message,
      name: err.name,
    });
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection (swallowed)", {
      err: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

export async function farm(): Promise<void> {
  installCrashGuards();

  log.info("farm starting", {
    batchSize: config.batchSize,
    batchSleepMs: config.batchSleepMs,
    maxDifficulty: config.maxDifficulty,
    pipelines: config.pipelines,
    workersPerPipeline: config.workersPerPipeline,
    proxyEnabled: Boolean(config.proxyUrl),
  });

  let totalOk = 0;
  let totalLamports = 0n;
  const startedAt = Date.now();

  const printStats = (label: string): void => {
    const elapsedMin = (Date.now() - startedAt) / 60_000;
    const totalSol = Number(totalLamports) / 1e9;
    const solPerHour = elapsedMin > 0 ? totalSol / (elapsedMin / 60) : 0;
    log.info(label, {
      totalOk,
      totalSol,
      elapsedMin: elapsedMin.toFixed(2),
      solPerHour: solPerHour.toFixed(2),
    });
  };

  process.on("SIGINT", () => {
    printStats("farm stopped");
    process.exit(0);
  });

  while (true) {
    try {
      const results = await runCycle(config.batchSize);
      for (const r of results) {
        if (r.success) {
          totalOk++;
          totalLamports += r.lamports;
        }
      }
      printStats("farm aggregate");

      // If nothing at all could run this cycle (e.g. all faucets are dry),
      // back off longer before retrying so we don't spam discovery.
      if (results.length === 0) {
        const longSleep = config.batchSleepMs * 6;
        log.warn("no claims possible, long sleep", { ms: longSleep });
        await new Promise((r) => setTimeout(r, longSleep));
        continue;
      }
    } catch (err) {
      log.error("cycle threw", { err: (err as Error).message });
    }
    await new Promise((r) => setTimeout(r, config.batchSleepMs));
  }
}
