import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { actionMetadata, acquireLease, parseConfig, releaseLease, stateName } from './coordinator.mjs';

async function writeCommand(file, name, value) {
  if (!file) return;
  if (/[\r\n]/.test(value)) throw new Error(`Refusing to write multiline ${name} to a GitHub Actions command file.`);
  await appendFile(file, `${name}=${value}\n`, 'utf8');
}

async function writeCommands(file, values) {
  if (!file) return;
  const lines = values.map(([name, value]) => {
    if (/[\r\n]/.test(value)) throw new Error(`Refusing to write multiline ${name} to a GitHub Actions command file.`);
    return `${name}=${value}`;
  });
  await appendFile(file, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const config = parseConfig();
  const ownerToken = randomUUID();
  // Persist recovery state before touching the shared capacity directory. That
  // makes the post step able to release a lease even if cancellation occurs
  // immediately after acquisition or output publication fails.
  await writeCommands(process.env.GITHUB_STATE, [
    [stateName('ROOT'), config.root],
    [stateName('HOST_ID'), config.hostId],
    [stateName('OWNER_TOKEN'), ownerToken],
    [stateName('CAPACITY_UNITS'), String(config.capacityUnits)],
    [stateName('LEASE_WEIGHT'), String(config.leaseWeight)],
    [stateName('TIMEOUT_SECONDS'), String(config.timeoutMs / 1000)],
    [stateName('POLL_INTERVAL_MS'), String(config.pollIntervalMs)],
    [stateName('STALE_AFTER_SECONDS'), String(config.staleAfterMs / 1000)],
    [stateName('HEARTBEAT_INTERVAL_SECONDS'), String(config.heartbeatIntervalSeconds)],
  ]);
  const lease = await acquireLease(config, { ownerToken, metadata: actionMetadata() });
  const heartbeatScript = fileURLToPath(new URL('./heartbeat.mjs', import.meta.url));
  const heartbeat = spawn(process.execPath, [heartbeatScript, ownerToken], {
    detached: true,
    stdio: 'ignore',
    env: {
      PHYSICAL_HOST_CAPACITY_ROOT: config.root,
      PHYSICAL_HOST_CAPACITY_HOST_ID: config.hostId,
      PHYSICAL_HOST_CAPACITY_UNITS: String(config.capacityUnits),
      PHYSICAL_HOST_CAPACITY_WEIGHT: String(config.leaseWeight),
      PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS: String(config.timeoutMs / 1000),
      PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS: String(config.pollIntervalMs),
      PHYSICAL_HOST_CAPACITY_STALE_AFTER_SECONDS: String(config.staleAfterSeconds),
      PHYSICAL_HOST_CAPACITY_HEARTBEAT_INTERVAL_SECONDS: String(config.heartbeatIntervalSeconds),
    },
  });
  heartbeat.unref();
  try {
    await writeCommand(process.env.GITHUB_STATE, stateName('HEARTBEAT_PID'), String(heartbeat.pid));
  } catch (error) {
    await releaseLease(config, ownerToken);
    throw error;
  }
  await writeCommand(process.env.GITHUB_OUTPUT, 'owner-token', lease.ownerToken);
  await writeCommand(process.env.GITHUB_OUTPUT, 'lease-path', lease.leasePath);
  await writeCommand(process.env.GITHUB_ENV, stateName('OWNER_TOKEN'), lease.ownerToken);
  await writeCommand(process.env.GITHUB_ENV, stateName('LEASE_PATH'), lease.leasePath);
  console.log(`Acquired physical-host capacity lease ${lease.ownerToken.slice(0, 8)} (weight=${config.leaseWeight}/${config.capacityUnits}, stale-recovered=${lease.recovered}).`);
}

main().catch((error) => {
  console.error(`Physical-host capacity coordination failed: ${error.message}`);
  process.exitCode = 1;
});
