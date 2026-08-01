import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

const STATE_DIRECTORY = '.kontour-physical-host-capacity';
const LEASE_DIRECTORY = 'leases';
const TICKET_DIRECTORY = 'tickets';
const CONTROL_LOCK_DIRECTORY = 'control.lock';
const MANIFEST_FILE = 'host-manifest.json';
const HOST_MARKER_FILE = '.kontour-physical-host-id';
const MANIFEST_SCHEMA_VERSION = 2;
const STALE_LEASE_STRATEGY = 'heartbeat-mtime-v1';
const CLEANUP_RETRY_MS = 5_000;
const MAX_DIAGNOSTIC_ENTRIES = 6;

export class CapacityCoordinationError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CapacityCoordinationError';
  }
}

const realClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
};

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
  if (!Number.isSafeInteger(milliseconds)) throw new CapacityCoordinationError(`${name} is too large.`);
  return { seconds, milliseconds };
}

function requiredPath(value) {
  if (!value || value.trim() === '' || /[\r\n]/.test(value)) {
    throw new CapacityCoordinationError('coordination-root is required and must not contain a newline.');
  }
  if (!isAbsolute(value)) {
    throw new CapacityCoordinationError('coordination-root must be an absolute, pre-provisioned path.');
  }
  return resolve(value);
}

function requiredHostId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value ?? '')) {
    throw new CapacityCoordinationError('host-id is required and must contain only letters, numbers, dots, underscores, or hyphens.');
  }
  return value;
}

export function parseConfig(env = process.env) {
  const root = requiredPath(input(env, 'coordination-root') ?? env.PHYSICAL_HOST_CAPACITY_ROOT);
  const hostId = requiredHostId(input(env, 'host-id') ?? env.PHYSICAL_HOST_CAPACITY_HOST_ID);
  const capacityUnits = positiveInteger(input(env, 'capacity-units') ?? env.PHYSICAL_HOST_CAPACITY_UNITS ?? '1', 'capacity-units');
  const leaseWeight = positiveInteger(input(env, 'lease-weight') ?? env.PHYSICAL_HOST_CAPACITY_WEIGHT ?? '1', 'lease-weight');
  const timeoutMs = durationMilliseconds(input(env, 'timeout-seconds') ?? env.PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS ?? '300', 'timeout-seconds', { allowZero: true }).milliseconds;
  const pollIntervalMs = positiveInteger(input(env, 'poll-interval-ms') ?? env.PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS ?? '1000', 'poll-interval-ms');
  const stale = durationMilliseconds(input(env, 'stale-after-seconds') ?? env.PHYSICAL_HOST_CAPACITY_STALE_AFTER_SECONDS ?? '1800', 'stale-after-seconds');
  const heartbeat = durationMilliseconds(input(env, 'heartbeat-interval-seconds') ?? env.PHYSICAL_HOST_CAPACITY_HEARTBEAT_INTERVAL_SECONDS ?? '30', 'heartbeat-interval-seconds');

  if (leaseWeight > capacityUnits) throw new CapacityCoordinationError(`lease-weight (${leaseWeight}) cannot exceed capacity-units (${capacityUnits}).`);
  if (heartbeat.milliseconds >= stale.milliseconds) throw new CapacityCoordinationError('heartbeat-interval-seconds must be shorter than stale-after-seconds.');

  return {
    root, hostId, capacityUnits, leaseWeight, timeoutMs, pollIntervalMs,
    staleAfterSeconds: stale.seconds, staleAfterMs: stale.milliseconds,
    heartbeatIntervalSeconds: heartbeat.seconds, heartbeatIntervalMs: heartbeat.milliseconds,
  };
}

function paths(root) {
  const state = join(root, STATE_DIRECTORY);
  return {
    state,
    marker: join(root, HOST_MARKER_FILE),
    manifest: join(state, MANIFEST_FILE),
    leases: join(state, LEASE_DIRECTORY),
    tickets: join(state, TICKET_DIRECTORY),
    controlLock: join(state, CONTROL_LOCK_DIRECTORY),
  };
}

async function assertDirectory(path, label) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new CapacityCoordinationError(`${label} must already exist at ${path}; run the provisioning command first.`, error);
  }
  if (!info.isDirectory()) throw new CapacityCoordinationError(`${label} at ${path} must be a directory.`);
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

function manifestFor(config) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    hostId: config.hostId,
    capacityUnits: config.capacityUnits,
    staleAfterSeconds: config.staleAfterSeconds,
    staleLeaseStrategy: STALE_LEASE_STRATEGY,
  };
}

function validManifest(manifest, path) {
  const expectedKeys = ['capacityUnits', 'hostId', 'schemaVersion', 'staleAfterSeconds', 'staleLeaseStrategy'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).sort().join(',') !== expectedKeys.join(',')) {
    throw new CapacityCoordinationError(`Invalid host manifest at ${path}; refusing to guess capacity configuration.`);
  }
  if (
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.hostId) ||
    !Number.isSafeInteger(manifest.capacityUnits) || manifest.capacityUnits < 1 ||
    !Number.isSafeInteger(manifest.staleAfterSeconds) || manifest.staleAfterSeconds < 1 ||
    manifest.staleLeaseStrategy !== STALE_LEASE_STRATEGY
  ) throw new CapacityCoordinationError(`Invalid host manifest at ${path}; refusing to guess capacity configuration.`);
  return manifest;
}

function assertManifestMatches(manifest, config, path) {
  const expected = manifestFor(config);
  for (const key of Object.keys(expected)) {
    if (manifest[key] !== expected[key]) {
      throw new CapacityCoordinationError(`Host manifest mismatch at ${path}: ${key} is ${JSON.stringify(manifest[key])}, but this job requires ${JSON.stringify(expected[key])}. Coordination cannot continue.`);
    }
  }
}

async function ensureProvisioned(config) {
  const location = paths(config.root);
  await assertDirectory(config.root, 'coordination-root');
  let marker;
  try {
    marker = await readFile(location.marker, 'utf8');
  } catch (error) {
    throw new CapacityCoordinationError(`External host marker is required at ${location.marker}; run the provisioning command first.`, error);
  }
  if (marker !== `${config.hostId}\n`) {
    throw new CapacityCoordinationError(`External host marker mismatch at ${location.marker}; coordination cannot continue.`);
  }
  await assertDirectory(location.state, 'coordination state directory');
  await assertDirectory(location.leases, 'lease directory');
  await assertDirectory(location.tickets, 'ticket directory');
  const manifest = validManifest(await readJson(location.manifest, 'host manifest'), location.manifest);
  assertManifestMatches(manifest, config, location.manifest);
}

export async function provisionHost(config) {
  const location = paths(config.root);
  await assertDirectory(config.root, 'coordination-root');
  try {
    const marker = await readFile(location.marker, 'utf8');
    if (marker !== `${config.hostId}\n`) throw new CapacityCoordinationError(`External host marker mismatch at ${location.marker}.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeExclusive(location.marker, `${config.hostId}\n`);
  }
  await mkdir(location.leases, { recursive: true });
  await mkdir(location.tickets, { recursive: true });
  try {
    const manifest = validManifest(await readJson(location.manifest, 'host manifest'), location.manifest);
    assertManifestMatches(manifest, config, location.manifest);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await readdir(location.leases)).length > 0 || (await readdir(location.tickets)).length > 0) {
      throw new CapacityCoordinationError('Cannot provision a manifest over existing leases or queue tickets.');
    }
    await writeExclusive(location.manifest, JSON.stringify(manifestFor(config)));
  }
}

function lockOwnerFile(lockPath, token) {
  return join(lockPath, `owner-${token}.json`);
}

async function releaseLock(lockPath, token) {
  try {
    await rm(lockOwnerFile(lockPath, token), { force: false });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// This is deliberately token-addressed: it can remove only this owner's
// marker, and rmdir refuses a non-empty replacement lock directory.
export async function releaseOwnedControlLock(root, ownerToken) {
  await releaseLock(paths(root).controlLock, ownerToken);
}

async function tryAcquireLock(lockPath, token, staleAfterMs, now) {
  try {
    await mkdir(lockPath);
    try {
      await writeFile(lockOwnerFile(lockPath, token), JSON.stringify({ ownerToken: token, acquiredAt: new Date(now()).toISOString() }), 'utf8');
      return true;
    } catch (error) {
      throw error;
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  // A released lock remains as an empty directory. Only an empty directory is
  // retired, then retried. Its owner marker is token-addressed and a holder
  // never removes the shared directory, so an old release cannot delete a
  // replacement mkdir owner during the write-metadata gap (ABA).
  let entries;
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (entries.length === 0) {
    const retiredLock = `${lockPath}.released-${token}`;
    try {
      await rename(lockPath, retiredLock);
      await rm(retiredLock, { recursive: true, force: true });
      return tryAcquireLock(lockPath, token, staleAfterMs, now);
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error;
    }
  }
  // Do not steal an owned control lock. NTFS and WSL do not provide a portable
  // compare-and-swap for a directory owner. A wedged lock fails closed and
  // requires the explicit recovery procedure documented with provisioning.
  return false;
}

async function withControlLock(root, { staleAfterMs, timeoutMs, pollIntervalMs, now, sleep }, operation) {
  const lockPath = paths(root).controlLock;
  const token = randomUUID();
  const deadline = now() + timeoutMs;
  while (true) {
    if (await tryAcquireLock(lockPath, token, staleAfterMs, now)) {
      try {
        return await operation();
      } finally {
        await releaseLock(lockPath, token);
      }
    }
    if (now() >= deadline) throw new CapacityCoordinationError('Timed out waiting for the capacity coordination control lock; automatic lock stealing is disabled, so use the documented manual recovery procedure after confirming no owner is live.');
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
}

function validLease(record, path) {
  if (!record || !/^[a-f0-9-]{36}$/i.test(record.ownerToken) || !Number.isSafeInteger(record.weight) || record.weight < 1 || typeof record.acquiredAt !== 'string') {
    throw new CapacityCoordinationError(`Invalid lease record at ${path}; refusing to guess capacity state.`);
  }
  return record;
}

function validTicket(record, path) {
  if (!record || !/^[a-f0-9-]{36}$/i.test(record.ownerToken) || !Number.isSafeInteger(record.weight) || record.weight < 1 || typeof record.enqueuedAt !== 'string' || Number.isNaN(Date.parse(record.enqueuedAt))) {
    throw new CapacityCoordinationError(`Invalid queue ticket at ${path}; refusing to guess capacity state.`);
  }
  return record;
}

async function listRecords(directory, label, validate, staleAfterMs, now) {
  const entries = await readdir(directory, { withFileTypes: true });
  const active = [];
  let recovered = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw new CapacityCoordinationError(`Unexpected ${label} entry at ${path}; refusing to guess capacity state.`);
    const info = await stat(path);
    const ageMs = Math.max(0, now() - info.mtimeMs);
    if (ageMs >= staleAfterMs) {
      await rm(path, { force: false });
      recovered += 1;
      continue;
    }
    active.push({ ...validate(await readJson(path, label), path), path, ageMs });
  }
  return { active, recovered };
}

function summarize(records, format) {
  const shown = records.slice(0, MAX_DIAGNOSTIC_ENTRIES).map(format);
  const omitted = records.length - shown.length;
  return `${shown.join('; ') || 'none'}${omitted > 0 ? `; omitted=${omitted}` : ''}`;
}

function describe(leases, tickets, capacityUnits) {
  const used = leases.reduce((total, lease) => total + lease.weight, 0);
  return `used=${used}/${capacityUnits}; leases=${summarize(leases, (lease) => `${lease.ownerToken.slice(0, 8)} weight=${lease.weight} age=${Math.ceil(lease.ageMs / 1000)}s`)}; queue=${summarize(tickets, (ticket) => `${ticket.ownerToken.slice(0, 8)} weight=${ticket.weight} age=${Math.ceil(ticket.ageMs / 1000)}s`)}`;
}

async function createTicket(config, ownerToken, now) {
  const ticketPath = join(paths(config.root).tickets, `${ownerToken}.json`);
  await writeExclusive(ticketPath, JSON.stringify({ ownerToken, weight: config.leaseWeight, enqueuedAt: new Date(now()).toISOString() }));
  return ticketPath;
}

async function removeTicket(config, ownerToken, { now = realClock.now, sleep = realClock.sleep } = {}) {
  const cleanup = { ...config, timeoutMs: Math.max(CLEANUP_RETRY_MS, config.pollIntervalMs), now, sleep };
  return withControlLock(config.root, cleanup, async () => {
    try {
      await rm(join(paths(config.root).tickets, `${ownerToken}.json`), { force: false });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

export async function acquireLease(config, { ownerToken = randomUUID(), now = realClock.now, sleep = realClock.sleep, metadata = {} } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(ownerToken)) throw new CapacityCoordinationError('ownerToken must be a UUID.');
  await ensureProvisioned(config);
  await createTicket(config, ownerToken, now);
  const deadline = now() + config.timeoutMs;
  let lastDescription = 'no capacity check completed';
  let recoveredLeases = 0;
  let recoveredTickets = 0;

  try {
    while (true) {
      const remaining = Math.max(0, deadline - now());
      const result = await withControlLock(config.root, { ...config, timeoutMs: remaining, now, sleep }, async () => {
        const ticketPath = join(paths(config.root).tickets, `${ownerToken}.json`);
        await utimes(ticketPath, new Date(now()), new Date(now()));
        const leaseRecords = await listRecords(paths(config.root).leases, 'lease record', validLease, config.staleAfterMs, now);
        const ticketRecords = await listRecords(paths(config.root).tickets, 'queue ticket', validTicket, config.staleAfterMs, now);
        recoveredLeases += leaseRecords.recovered;
        recoveredTickets += ticketRecords.recovered;
        const tickets = ticketRecords.active.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt) || a.ownerToken.localeCompare(b.ownerToken));
        lastDescription = describe(leaseRecords.active, tickets, config.capacityUnits);
        const position = tickets.findIndex((ticket) => ticket.ownerToken === ownerToken);
        if (position < 0) throw new CapacityCoordinationError('This job queue ticket disappeared before admission; refusing to continue.');
        const used = leaseRecords.active.reduce((total, lease) => total + lease.weight, 0);
        if (position !== 0 || used + config.leaseWeight > config.capacityUnits) return null;

        const leasePath = join(paths(config.root).leases, `${ownerToken}.json`);
        await writeExclusive(leasePath, JSON.stringify({ ...metadata, ownerToken, weight: config.leaseWeight, acquiredAt: new Date(now()).toISOString() }));
        await rm(ticketPath, { force: false });
        return { leasePath };
      });
      if (result) return { ownerToken, ...result, recovered: recoveredLeases, recoveredTickets };
      if (now() >= deadline) throw new CapacityCoordinationError(`Timed out after ${Math.ceil(config.timeoutMs / 1000)}s waiting for physical-host capacity (${lastDescription}; recovered-stale-leases=${recoveredLeases}; recovered-stale-tickets=${recoveredTickets}).`);
      await sleep(Math.min(config.pollIntervalMs, Math.max(1, deadline - now())));
    }
  } catch (error) {
    try {
      await removeTicket(config, ownerToken, { now, sleep });
    } catch (cleanupError) {
      throw new CapacityCoordinationError(`${error.message} Queue ticket cleanup also failed: ${cleanupError.message}`, cleanupError);
    }
    throw error;
  }
}

export async function heartbeatLease(config, ownerToken, { now = realClock.now, sleep = realClock.sleep } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(ownerToken)) throw new CapacityCoordinationError('ownerToken must be a UUID.');
  await ensureProvisioned(config);
  const cleanup = { ...config, timeoutMs: Math.max(CLEANUP_RETRY_MS, config.pollIntervalMs), now, sleep };
  return withControlLock(config.root, cleanup, async () => {
    const leasePath = join(paths(config.root).leases, `${ownerToken}.json`);
    try {
      const lease = validLease(await readJson(leasePath, 'lease record'), leasePath);
      if (lease.ownerToken !== ownerToken) throw new CapacityCoordinationError(`Lease ownership mismatch at ${leasePath}; refusing to heartbeat another job's capacity.`);
      const timestamp = new Date(now());
      await utimes(leasePath, timestamp, timestamp);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

export async function releaseLease(config, ownerToken, { now = realClock.now, sleep = realClock.sleep } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(ownerToken)) throw new CapacityCoordinationError('ownerToken must be a UUID.');
  await ensureProvisioned(config);
  const cleanup = { ...config, timeoutMs: Math.max(CLEANUP_RETRY_MS, config.pollIntervalMs), now, sleep };
  return withControlLock(config.root, cleanup, async () => {
    const leasePath = join(paths(config.root).leases, `${ownerToken}.json`);
    try {
      const lease = validLease(await readJson(leasePath, 'lease record'), leasePath);
      if (lease.ownerToken !== ownerToken) throw new CapacityCoordinationError(`Lease ownership mismatch at ${leasePath}; refusing to release another job's capacity.`);
      await rm(leasePath, { force: false });
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

export function actionMetadata(env = process.env) {
  return { repository: env.GITHUB_REPOSITORY ?? 'unknown', runId: env.GITHUB_RUN_ID ?? 'unknown', job: env.GITHUB_JOB ?? 'unknown', runnerOs: env.RUNNER_OS ?? 'unknown' };
}

export function stateName(name) {
  return `PHYSICAL_HOST_CAPACITY_${name}`;
}

export function leaseFileName(path) {
  return basename(path);
}
