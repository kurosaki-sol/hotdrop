// Main entry point: starts the optional HTTP API, then enters the farming
// loop. Use this when you want hotdrop running as a service.
//
// If you only want the HTTP API (and you'll farm on another machine, or you're
// just integrating a pre-funded wallet), run `npm run api`. If you only want
// to farm once without a loop, run `npm run claim`.

import { startApi } from "./api.js";
import { farm } from "./farm.js";
import { log } from "./logger.js";

async function main(): Promise<void> {
  await startApi();
  await farm();
}

main().catch((err) => {
  log.error("fatal", { err: (err as Error).message });
  process.exit(1);
});
