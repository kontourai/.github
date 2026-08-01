#!/usr/bin/env node

import { parseConfig, provisionHost } from '../actions/physical-host-capacity/coordinator.mjs';

function argumentsToEnvironment(argumentsList) {
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error('Expected --root, --host-id, and --capacity-units values.');
    values[flag.slice(2)] = value;
  }
  return {
    PHYSICAL_HOST_CAPACITY_ROOT: values.root,
    PHYSICAL_HOST_CAPACITY_HOST_ID: values['host-id'],
    PHYSICAL_HOST_CAPACITY_UNITS: values['capacity-units'],
    PHYSICAL_HOST_CAPACITY_WEIGHT: '1',
    PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS: '0',
    PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS: '1000',
  };
}

async function main() {
  const config = parseConfig(argumentsToEnvironment(process.argv.slice(2)));
  await provisionHost(config);
  console.log(`Provisioned physical-host capacity root ${config.root} for ${config.hostId}.`);
}

main().catch((error) => {
  console.error(`Physical-host capacity provisioning failed: ${error.message}`);
  process.exitCode = 1;
});
