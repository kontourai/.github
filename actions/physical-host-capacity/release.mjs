import { parseConfig, releaseLease, stateName } from './coordinator.mjs';

function postEnvironment() {
  const read = (name) => process.env[`STATE_${stateName(name)}`];
  return {
    ...process.env,
    PHYSICAL_HOST_CAPACITY_ROOT: read('ROOT'),
    PHYSICAL_HOST_CAPACITY_HOST_ID: read('HOST_ID'),
    PHYSICAL_HOST_CAPACITY_UNITS: read('CAPACITY_UNITS'),
    PHYSICAL_HOST_CAPACITY_WEIGHT: read('LEASE_WEIGHT'),
    PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS: read('TIMEOUT_SECONDS'),
    PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS: read('POLL_INTERVAL_MS'),
    PHYSICAL_HOST_CAPACITY_STALE_AFTER_SECONDS: read('STALE_AFTER_SECONDS'),
    PHYSICAL_HOST_CAPACITY_HEARTBEAT_INTERVAL_SECONDS: read('HEARTBEAT_INTERVAL_SECONDS'),
  };
}

async function main() {
  const ownerToken = process.env[`STATE_${stateName('OWNER_TOKEN')}`];
  if (!ownerToken) {
    console.log('Physical-host capacity post step has no acquired lease to release.');
    return;
  }
  const heartbeatPid = process.env[`STATE_${stateName('HEARTBEAT_PID')}`];
  if (heartbeatPid && /^[1-9][0-9]*$/.test(heartbeatPid)) {
    try {
      process.kill(Number(heartbeatPid), 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  const released = await releaseLease(parseConfig(postEnvironment()), ownerToken);
  console.log(released ? `Released physical-host capacity lease ${ownerToken.slice(0, 8)}.` : `Physical-host capacity lease ${ownerToken.slice(0, 8)} was already absent.`);
}

main().catch((error) => {
  console.error(`Physical-host capacity release failed: ${error.message}`);
  process.exitCode = 1;
});
