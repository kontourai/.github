#!/usr/bin/env node

import { migrateOwnerLifetime, parseConfig } from '../actions/physical-host-capacity/coordinator.mjs';

function pairedArguments(argumentsList) {
  if (argumentsList.length % 2 !== 0) throw new Error('Expected paired migration arguments.');
  const values = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error('Expected --root, --host-id, --capacity-units, --old-owner-lifetime-seconds, and --new-owner-lifetime-seconds values.');
    }
    const name = flag.slice(2);
    if (values[name] !== undefined) throw new Error(`Duplicate migration argument ${flag}.`);
    values[name] = value;
  }
  const allowed = new Set([
    'root',
    'host-id',
    'capacity-units',
    'old-owner-lifetime-seconds',
    'new-owner-lifetime-seconds',
  ]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) throw new Error(`Unsupported migration argument --${name}.`);
  }
  for (const name of allowed) {
    if (values[name] === undefined) throw new Error(`Migration requires --${name}.`);
  }
  return values;
}

function configuration(values, ownerLifetimeSeconds) {
  return parseConfig({
    PHYSICAL_HOST_CAPACITY_ROOT: values.root,
    PHYSICAL_HOST_CAPACITY_HOST_ID: values['host-id'],
    PHYSICAL_HOST_CAPACITY_UNITS: values['capacity-units'],
    PHYSICAL_HOST_CAPACITY_WEIGHT: '1',
    PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS: '0',
    PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS: '1000',
    PHYSICAL_HOST_CAPACITY_OWNER_LIFETIME_SECONDS: ownerLifetimeSeconds,
  });
}

async function main() {
  const values = pairedArguments(process.argv.slice(2));
  const result = await migrateOwnerLifetime(
    configuration(values, values['old-owner-lifetime-seconds']),
    configuration(values, values['new-owner-lifetime-seconds']),
  );
  console.log(
    result.migrated
      ? `Migrated physical-host owner lifetime to 7800 seconds; retained exact 6000-second backup at ${result.backupPath}.`
      : `Physical-host owner lifetime is already 7800 seconds; validated exact host contract.`,
  );
}

main().catch((error) => {
  console.error(`Physical-host owner-lifetime migration failed: ${error.message}`);
  process.exitCode = 1;
});
