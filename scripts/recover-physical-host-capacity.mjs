#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';

import { parseConfig, recoverAbandonedRecord } from '../actions/physical-host-capacity/coordinator.mjs';

function argumentsToValues(argumentsList) {
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error('Expected paired --root, --host-id, --capacity-units, --recover, and --quiescence-marker values.');
    values[flag.slice(2)] = value;
  }
  return values;
}

async function assertQuiesced(markerPath, hostId) {
  const info = await lstat(markerPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Quiescence marker must be a regular file, not a symlink or junction: ${markerPath}`);
  if (await readFile(markerPath, 'utf8') !== `${hostId}\n`) {
    throw new Error(`Quiescence marker must contain exactly ${JSON.stringify(`${hostId}\n`)} after runners have been drained.`);
  }
}

async function main() {
  const values = argumentsToValues(process.argv.slice(2));
  const config = parseConfig({
    PHYSICAL_HOST_CAPACITY_ROOT: values.root,
    PHYSICAL_HOST_CAPACITY_HOST_ID: values['host-id'],
    PHYSICAL_HOST_CAPACITY_UNITS: values['capacity-units'],
    PHYSICAL_HOST_CAPACITY_WEIGHT: '1',
    PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS: '0',
    PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS: '1000',
  });
  if (!values.recover || !values['quiescence-marker']) throw new Error('Recovery requires explicit --recover and --quiescence-marker values after runners are drained.');
  const [kind, ownerToken] = values.recover.split(':', 2);
  await assertQuiesced(values['quiescence-marker'], config.hostId);
  const recoveredPath = await recoverAbandonedRecord(config, { kind, ownerToken });
  console.log(`Recovered confirmed-abandoned ${kind} record at ${recoveredPath}.`);
}

main().catch((error) => {
  console.error(`Physical-host capacity recovery failed: ${error.message}`);
  process.exitCode = 1;
});
