import { parseConfig, releaseLease, stateName } from './coordinator.mjs';

function postEnvironment() {
  const read = (name) => process.env[`STATE_${stateName(name)}`];
  return {
    PHYSICAL_HOST_CAPACITY_ROOT: read('ROOT'),
    PHYSICAL_HOST_CAPACITY_HOST_ID: read('HOST_ID'),
    PHYSICAL_HOST_CAPACITY_UNITS: read('CAPACITY_UNITS'),
    PHYSICAL_HOST_CAPACITY_WEIGHT: read('LEASE_WEIGHT'),
    PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS: read('TIMEOUT_SECONDS'),
    PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS: read('POLL_INTERVAL_MS'),
  };
}

async function main() {
  const ownerToken = process.env[`STATE_${stateName('OWNER_TOKEN')}`];
  if (!ownerToken) {
    console.log('Physical-host capacity post step has no acquired lease to release.');
    return;
  }
  const released = await releaseLease(parseConfig(postEnvironment()), ownerToken);
  console.log(released ? `Released physical-host capacity lease ${ownerToken.slice(0, 8)}.` : `Physical-host capacity lease ${ownerToken.slice(0, 8)} was already absent.`);
}

main().catch((error) => {
  console.error(`Physical-host capacity release failed: ${error.message}`);
  process.exitCode = 1;
});
