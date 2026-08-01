import { heartbeatLease, parseConfig } from './coordinator.mjs';

const ownerToken = process.argv[2];
let stopping = false;

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function main() {
  const config = parseConfig();
  while (!stopping) {
    try {
      if (!(await heartbeatLease(config, ownerToken))) return;
    } catch (error) {
      // A transient control-lock conflict must not silently stop liveness.
      // Keep retrying; a hard process loss is recovered after stale-after.
      console.error(`Physical-host capacity heartbeat retry: ${error.message}`);
    }
    await sleep(config.heartbeatIntervalMs);
  }
}

main().catch((error) => {
  console.error(`Physical-host capacity heartbeat failed: ${error.message}`);
  process.exitCode = 1;
});
