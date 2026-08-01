import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const STATE_DIRECTORY = '.kontour-physical-host-capacity';
const LEASE_DIRECTORY = 'leases';
const CONTROL_LOCK_DIRECTORY = 'control.lock';

export class CapacityCoordinationError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CapacityCoordinationError';
  }
}

function input(env, name) {
  return env[`INPUT_${name.replaceAll('-', '_').toUpperCase()}`];
}

function positiveInteger(value, name, { allowZero = false } = {}) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value ?? '')) {
    throw new CapacityCoordinationError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer; received ${JSON.stringify(value ?? '')}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed === 0)) {
    throw new CapacityCoordinationError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer; received ${JSON.stringify(value)}.`);
  }
  return parsed;
}

function durationMilliseconds(value, name, options) {
  const seconds = positiveInteger(value, name, options);
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new CapacityCoordinationError(`${name} is too large.`);
  }
  return milliseconds;
}

function requiredPath(value) {
  if (!value || value.trim() === '') {
    throw new CapacityCoordinationError('coordination-root is required. Coordination cannot be bypassed.');
  }
  if (/[\r\n]/.test(value)) {
    throw new CapacityCoordinationError('coordination-root must not contain a newline.');
  }
  return resolve(value);
}

export function parseConfig(env = process.env) {
  const root = requiredPath(input(env, 'coordination-root') ?? env.PHYSICAL_HOST_CAPACITY_ROOT);
  const capacityUnits = positiveInteger(input(env, 'capacity-units') ?? env.PHYSICAL_HOST_CAPACITY_UNITS ?? '1', 'capacity-units');
  const leaseWeight = positiveInteger(input(env, 'lease-weight') ?? env.PHYSICAL_HOST_CAPACITY_WEIGHT ?? '1', 'lease-weight');
  const timeoutMs = durationMilliseconds(input(env, 'timeout-seconds') ?? env.PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS ?? '300', 'timeout-seconds', { allowZero: true });
  const pollIntervalMs = positiveInteger(input(env, 'poll-interval-ms') ?? env.PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS ?? '1000', 'poll-interval-ms');
  const staleAfterMs = durationMilliseconds(input(env, 'stale-after-seconds') ?? env.PHYSICAL_HOST_CAPACITY_STALE_AFTER_SECONDS ?? '1800', 'stale-after-seconds');

  if (leaseWeight > capacityUnits) {
    throw new CapacityCoordinationError(`lease-weight (${leaseWeight}) cannot exceed capacity-units (${capacityUnits}).`);
  }

  return { root, capacityUnits, leaseWeight, timeoutMs, pollIntervalMs, staleAfterMs };
}

function paths(root) {
  const state = join(root, STATE_DIRECTORY);
  return {
    state,
    leases: join(state, LEASE_DIRECTORY),
    controlLock: join(state, CONTROL_LOCK_DIRECTORY),
  };
}

async function ensureLayout(root) {
  const { leases } = paths(root);
  await mkdir(leases, { recursive: true });
}

async function readJson(path, label) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const wrapped = new CapacityCoordinationError(`Unable to read ${label} at ${path}: ${error.message}`, error);
    wrapped.code = error.code;
    throw wrapped;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CapacityCoordinationError(`Invalid ${label} at ${path}; refusing to guess capacity state.`, error);
  }
}

async function writeExclusive(path, contents) {
  let handle;
  try {
    handle = await open(path, 'wx');
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle?.close();
  }
}

function validLease(record, path) {
  if (
    !record ||
    typeof record.ownerToken !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(record.ownerToken) ||
    !Number.isSafeInteger(record.weight) ||
    record.weight < 1 ||
    typeof record.acquiredAt !== 'string'
  ) {
    throw new CapacityCoordinationError(`Invalid lease record at ${path}; refusing to guess capacity state.`);
  }
  return record;
}

async function listLeases(root, staleAfterMs, now) {
  const { leases } = paths(root);
  const entries = await readdir(leases, { withFileTypes: true });
  const active = [];
  const recovered = [];

  for (const entry of entries) {
    const leasePath = join(leases, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new CapacityCoordinationError(`Unexpected coordination entry at ${leasePath}; refusing to guess capacity state.`);
    }
    const info = await stat(leasePath);
    const ageMs = Math.max(0, now() - info.mtimeMs);
    if (ageMs >= staleAfterMs) {
      await rm(leasePath, { force: false });
      recovered.push({ path: leasePath, ageMs });
      continue;
    }
    const record = validLease(await readJson(leasePath, 'lease record'), leasePath);
    active.push({ ...record, path: leasePath, ageMs });
  }
  return { active, recovered };
}

async function releaseControlLock(lockPath, token) {
  try {
    const record = await readJson(join(lockPath, 'owner.json'), 'control-lock record');
    if (record.ownerToken === token) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function tryAcquireControlLock(root, token, staleAfterMs, now) {
  const { controlLock } = paths(root);
  try {
    await mkdir(controlLock);
    try {
      await writeFile(join(controlLock, 'owner.json'), JSON.stringify({ ownerToken: token, acquiredAt: new Date(now()).toISOString() }), 'utf8');
      return true;
    } catch (error) {
      await rm(controlLock, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  let info;
  try {
    info = await stat(controlLock);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (Math.max(0, now() - info.mtimeMs) < staleAfterMs) return false;

  const staleLock = `${controlLock}.stale-${token}`;
  try {
    await rename(controlLock, staleLock);
    await rm(staleLock, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error;
  }
  return false;
}

async function withControlLock(root, { staleAfterMs, timeoutMs, pollIntervalMs, now, sleep }, operation) {
  const token = randomUUID();
  const deadline = now() + timeoutMs;
  while (true) {
    if (await tryAcquireControlLock(root, token, staleAfterMs, now)) {
      try {
        return await operation();
      } finally {
        await releaseControlLock(paths(root).controlLock, token);
      }
    }
    if (now() >= deadline) {
      throw new CapacityCoordinationError('Timed out waiting for the capacity coordination control lock.');
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
}

function describe(active, capacityUnits) {
  const used = active.reduce((total, lease) => total + lease.weight, 0);
  const details = active
    .sort((a, b) => a.ownerToken.localeCompare(b.ownerToken))
    .map((lease) => `${lease.ownerToken.slice(0, 8)} weight=${lease.weight} age=${Math.ceil(lease.ageMs / 1000)}s`)
    .join('; ');
  return `used=${used}/${capacityUnits}; active=${details || 'none'}`;
}

const realClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
};

export async function acquireLease(config, { ownerToken = randomUUID(), now = realClock.now, sleep = realClock.sleep, metadata = {} } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(ownerToken)) {
    throw new CapacityCoordinationError('ownerToken must be a UUID.');
  }
  await ensureLayout(config.root);
  const deadline = now() + config.timeoutMs;
  let lastDescription = 'no capacity check completed';
  let totalRecovered = 0;

  while (true) {
    const remaining = Math.max(0, deadline - now());
    const result = await withControlLock(
      config.root,
      { ...config, timeoutMs: remaining, now, sleep },
      async () => {
        const { active, recovered } = await listLeases(config.root, config.staleAfterMs, now);
        totalRecovered += recovered.length;
        lastDescription = describe(active, config.capacityUnits);
        const used = active.reduce((total, lease) => total + lease.weight, 0);
        if (used + config.leaseWeight > config.capacityUnits) return null;

        const leasePath = join(paths(config.root).leases, `${ownerToken}.json`);
        const record = {
          ownerToken,
          weight: config.leaseWeight,
          acquiredAt: new Date(now()).toISOString(),
          ...metadata,
        };
        await writeExclusive(leasePath, JSON.stringify(record));
        return { leasePath, recovered: totalRecovered };
      },
    );

    if (result) return { ownerToken, ...result };
    if (now() >= deadline) {
      throw new CapacityCoordinationError(`Timed out after ${Math.ceil(config.timeoutMs / 1000)}s waiting for physical-host capacity (${lastDescription}; recovered-stale=${totalRecovered}).`);
    }
    await sleep(Math.min(config.pollIntervalMs, Math.max(1, deadline - now())));
  }
}

export async function releaseLease(config, ownerToken, { now = realClock.now, sleep = realClock.sleep } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(ownerToken)) {
    throw new CapacityCoordinationError('ownerToken must be a UUID.');
  }
  await ensureLayout(config.root);
  const result = await withControlLock(config.root, { ...config, now, sleep }, async () => {
    const leasePath = join(paths(config.root).leases, `${ownerToken}.json`);
    try {
      const record = validLease(await readJson(leasePath, 'lease record'), leasePath);
      if (record.ownerToken !== ownerToken) {
        throw new CapacityCoordinationError(`Lease ownership mismatch at ${leasePath}; refusing to release another job's capacity.`);
      }
      await rm(leasePath, { force: false });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
  return result;
}

export function actionMetadata(env = process.env) {
  return {
    repository: env.GITHUB_REPOSITORY ?? 'unknown',
    runId: env.GITHUB_RUN_ID ?? 'unknown',
    job: env.GITHUB_JOB ?? 'unknown',
    runnerOs: env.RUNNER_OS ?? 'unknown',
  };
}

export function stateName(name) {
  return `PHYSICAL_HOST_CAPACITY_${name}`;
}

export function leaseFileName(path) {
  return basename(path);
}
