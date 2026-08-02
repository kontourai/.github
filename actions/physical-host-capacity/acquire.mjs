import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  CapacityCoordinationError,
  actionMetadata,
  acquireLease,
  parseConfig,
  releaseLease,
  stateName,
} from './coordinator.mjs';

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

export async function runAcquireAction({
  env = process.env,
  ownerToken = randomUUID(),
  writeOne = writeCommand,
  writeMany = writeCommands,
} = {}) {
  const config = parseConfig(env);
  let lease;

  try {
    // Persist recovery state before touching the shared capacity directory. That
    // makes the post step able to release a lease even if cancellation occurs
    // immediately after acquisition or output publication fails.
    await writeMany(env.GITHUB_STATE, [
      [stateName('ROOT'), config.root],
      [stateName('HOST_ID'), config.hostId],
      [stateName('OWNER_TOKEN'), ownerToken],
      [stateName('CAPACITY_UNITS'), String(config.capacityUnits)],
      [stateName('LEASE_WEIGHT'), String(config.leaseWeight)],
      [stateName('TIMEOUT_SECONDS'), String(config.timeoutMs / 1000)],
      [stateName('POLL_INTERVAL_MS'), String(config.pollIntervalMs)],
      [stateName('OWNER_LIFETIME_SECONDS'), String(config.ownerLifetimeSeconds)],
    ]);
    lease = await acquireLease(config, { ownerToken, metadata: actionMetadata(env) });
    await writeOne(env.GITHUB_OUTPUT, 'owner-token', lease.ownerToken);
    await writeOne(env.GITHUB_OUTPUT, 'lease-path', lease.leasePath);
    await writeOne(env.GITHUB_ENV, stateName('OWNER_TOKEN'), lease.ownerToken);
    await writeOne(env.GITHUB_ENV, stateName('LEASE_PATH'), lease.leasePath);
    console.log(`Acquired physical-host capacity lease ${lease.ownerToken.slice(0, 8)} (weight=${config.leaseWeight}/${config.capacityUnits}).`);
    return lease;
  } catch (error) {
    if (!lease) throw error;

    let cleanup;
    try {
      const released = await releaseLease(config, lease.ownerToken);
      cleanup = released ? 'released the owned lease' : 'found the owned lease already absent';
    } catch (cleanupError) {
      throw new CapacityCoordinationError(
        `Physical-host capacity command publication failed after acquiring lease ${lease.ownerToken.slice(0, 8)}: ${error.message}. Direct cleanup also failed: ${cleanupError.message}`,
        error,
      );
    }
    throw new CapacityCoordinationError(
      `Physical-host capacity command publication failed after acquiring lease ${lease.ownerToken.slice(0, 8)}: ${error.message}. Direct cleanup ${cleanup}; the post step remains idempotent.`,
      error,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAcquireAction().catch((error) => {
    console.error(`Physical-host capacity coordination failed: ${error.message}`);
    process.exitCode = 1;
  });
}
