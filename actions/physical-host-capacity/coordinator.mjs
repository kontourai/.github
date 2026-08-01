import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

const STATE_DIRECTORY = '.kontour-physical-host-capacity';
const LEASE_DIRECTORY = 'leases';
const TICKET_DIRECTORY = 'tickets';
const CONTROL_TICKET_DIRECTORY = 'control-tickets';
const QUEUE_SEQUENCE_FILE = 'queue-sequence.json';
const MANIFEST_FILE = 'host-manifest.json';
const HOST_MARKER_FILE = '.kontour-physical-host-id';
const MANIFEST_SCHEMA_VERSION = 5;
const RECOVERY_STRATEGY = 'explicit-quiesced-recovery-v1';
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

  if (leaseWeight > capacityUnits) throw new CapacityCoordinationError(`lease-weight (${leaseWeight}) cannot exceed capacity-units (${capacityUnits}).`);

  return {
    root, hostId, capacityUnits, leaseWeight, timeoutMs, pollIntervalMs,
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
    controlTickets: join(state, CONTROL_TICKET_DIRECTORY),
    queueSequence: join(state, QUEUE_SEQUENCE_FILE),
  };
}

async function assertDirectory(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new CapacityCoordinationError(`${label} must already exist at ${path}; run the provisioning command first.`, error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new CapacityCoordinationError(`${label} at ${path} must be a real directory, not a symlink or junction.`);
}

async function createRealDirectory(path, label) {
  try {
    await assertDirectory(path, label);
    return;
  } catch (error) {
    if (error.cause?.code !== 'ENOENT') throw error;
  }
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await assertDirectory(path, label);
}

async function assertRegularFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    const wrapped = new CapacityCoordinationError(`Unable to inspect ${label} at ${path}: ${error.message}`, error);
    wrapped.code = error.code;
    throw wrapped;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new CapacityCoordinationError(`${label} at ${path} must be a regular file, not a symlink or junction.`);
}

async function readJson(path, label) {
  await assertRegularFile(path, label);
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

async function removeRegularRecord(path, label) {
  await assertRegularFile(path, label);
  await rm(path, { force: false });
}

function manifestFor(config) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    hostId: config.hostId,
    capacityUnits: config.capacityUnits,
    recoveryStrategy: RECOVERY_STRATEGY,
  };
}

function validManifest(manifest, path) {
  const expectedKeys = ['capacityUnits', 'hostId', 'recoveryStrategy', 'schemaVersion'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).sort().join(',') !== expectedKeys.join(',')) {
    throw new CapacityCoordinationError(`Invalid host manifest at ${path}; refusing to guess capacity configuration.`);
  }
  if (
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.hostId) ||
    !Number.isSafeInteger(manifest.capacityUnits) || manifest.capacityUnits < 1 ||
    manifest.recoveryStrategy !== RECOVERY_STRATEGY
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
    await assertRegularFile(location.marker, 'external host marker');
    marker = await readFile(location.marker, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new CapacityCoordinationError(`External host marker is required at ${location.marker}; run the provisioning command first.`, error);
  }
  if (marker !== `${config.hostId}\n`) {
    throw new CapacityCoordinationError(`External host marker mismatch at ${location.marker}; coordination cannot continue.`);
  }
  await assertDirectory(location.state, 'coordination state directory');
  await assertDirectory(location.leases, 'lease directory');
  await assertDirectory(location.tickets, 'ticket directory');
  await assertDirectory(location.controlTickets, 'control-ticket directory');
  const sequence = await readJson(location.queueSequence, 'queue sequence');
  if (!Number.isSafeInteger(sequence.next) || sequence.next < 1 || Object.keys(sequence).length !== 1) {
    throw new CapacityCoordinationError(`Invalid queue sequence at ${location.queueSequence}; refusing to guess FIFO order.`);
  }
  const manifest = validManifest(await readJson(location.manifest, 'host manifest'), location.manifest);
  assertManifestMatches(manifest, config, location.manifest);
}

export async function provisionHost(config) {
  const location = paths(config.root);
  await assertDirectory(config.root, 'coordination-root');
  try {
    await assertRegularFile(location.marker, 'external host marker');
    const marker = await readFile(location.marker, 'utf8');
    if (marker !== `${config.hostId}\n`) throw new CapacityCoordinationError(`External host marker mismatch at ${location.marker}.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeExclusive(location.marker, `${config.hostId}\n`);
  }
  // Do not use recursive mkdir here: it follows a pre-existing symlink or
  // junction in the state path. Each component is inspected before creating
  // its direct child, so provisioning never writes through a redirect.
  await createRealDirectory(location.state, 'coordination state directory');
  await createRealDirectory(location.leases, 'lease directory');
  await createRealDirectory(location.tickets, 'ticket directory');
  await createRealDirectory(location.controlTickets, 'control-ticket directory');
  try {
    const sequence = await readJson(location.queueSequence, 'queue sequence');
    if (!Number.isSafeInteger(sequence.next) || sequence.next < 1 || Object.keys(sequence).length !== 1) throw new CapacityCoordinationError(`Invalid queue sequence at ${location.queueSequence}.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeExclusive(location.queueSequence, JSON.stringify({ next: 1 }));
  }
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

async function withControlLock(root, { timeoutMs, pollIntervalMs, now, sleep }, operation) {
  // The directory itself is the complete ownership record: mkdir is atomic on
  // the shared filesystem, so another participant can never observe an empty
  // lock before its owner has been published. There is intentionally no stale
  // lock stealing; recovery is a human operation after checking the host.
  const controlPath = join(paths(root).controlTickets, 'active');
  const deadline = now() + timeoutMs;
  while (true) {
    try {
      await mkdir(controlPath);
      try {
        return await operation();
      } finally {
        await rm(controlPath, { recursive: true, force: false });
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let info;
      try {
        info = await lstat(controlPath);
      } catch (inspectionError) {
        // The owner can release between mkdir's EEXIST and inspection. That is
        // a normal handoff, not evidence that a path may be followed.
        if (inspectionError.code === 'ENOENT') continue;
        throw inspectionError;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new CapacityCoordinationError(`Invalid control-ticket entry at ${controlPath}; refusing to follow a symlink or junction.`);
      }
      if (now() >= deadline) throw new CapacityCoordinationError('Timed out waiting for the capacity coordination control ticket; automatic control-ticket stealing is disabled, so use the documented manual recovery procedure after confirming no owner is live.');
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    }
  }
}

function validLease(record, path) {
  if (!record || !/^[a-f0-9-]{36}$/i.test(record.ownerToken) || !Number.isSafeInteger(record.weight) || record.weight < 1 || typeof record.acquiredAt !== 'string') {
    throw new CapacityCoordinationError(`Invalid lease record at ${path}; refusing to guess capacity state.`);
  }
  return record;
}

function validTicket(record, path) {
  if (!record || !/^[a-f0-9-]{36}$/i.test(record.ownerToken) || !Number.isSafeInteger(record.weight) || record.weight < 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1) {
    throw new CapacityCoordinationError(`Invalid queue ticket at ${path}; refusing to guess capacity state.`);
  }
  return record;
}

async function listRecords(directory, label, validate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const active = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw new CapacityCoordinationError(`Unexpected ${label} entry at ${path}; refusing to guess capacity state.`);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new CapacityCoordinationError(`Unexpected ${label} entry at ${path}; refusing to follow a symlink or junction.`);
    active.push({ ...validate(await readJson(path, label), path), path });
  }
  return { active };
}

function summarize(records, format) {
  const shown = records.slice(0, MAX_DIAGNOSTIC_ENTRIES).map(format);
  const omitted = records.length - shown.length;
  return `${shown.join('; ') || 'none'}${omitted > 0 ? `; omitted=${omitted}` : ''}`;
}

function describe(leases, tickets, capacityUnits) {
  const used = leases.reduce((total, lease) => total + lease.weight, 0);
  return `used=${used}/${capacityUnits}; leases=${summarize(leases, (lease) => `${lease.ownerToken.slice(0, 8)} weight=${lease.weight}`)}; queue=${summarize(tickets, (ticket) => `${ticket.ownerToken.slice(0, 8)} weight=${ticket.weight}`)}`;
}

async function createTicket(config, ownerToken) {
  const sequencePath = paths(config.root).queueSequence;
  const sequence = await readJson(sequencePath, 'queue sequence');
  if (!Number.isSafeInteger(sequence.next) || sequence.next < 1 || Object.keys(sequence).length !== 1) {
    throw new CapacityCoordinationError(`Invalid queue sequence at ${sequencePath}; refusing to guess FIFO order.`);
  }
  await writeFile(sequencePath, JSON.stringify({ next: sequence.next + 1 }), 'utf8');
  const ticketPath = join(paths(config.root).tickets, `${ownerToken}.json`);
  await writeExclusive(ticketPath, JSON.stringify({ ownerToken, weight: config.leaseWeight, sequence: sequence.next }));
  return ticketPath;
}

async function removeTicket(config, ownerToken, { now = realClock.now, sleep = realClock.sleep } = {}) {
  const cleanup = { ...config, timeoutMs: Math.max(CLEANUP_RETRY_MS, config.pollIntervalMs), now, sleep };
  return withControlLock(config.root, cleanup, async () => {
    try {
      await removeRegularRecord(join(paths(config.root).tickets, `${ownerToken}.json`), 'queue ticket');
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
  const deadline = now() + config.timeoutMs;
  let lastDescription = 'no capacity check completed';
  let ticketCreated = false;

  try {
    await withControlLock(config.root, { ...config, timeoutMs: config.timeoutMs, now, sleep }, async () => {
      await createTicket(config, ownerToken);
      ticketCreated = true;
    });
    while (true) {
      const remaining = Math.max(0, deadline - now());
      const result = await withControlLock(config.root, { ...config, timeoutMs: remaining, now, sleep }, async () => {
        const ticketPath = join(paths(config.root).tickets, `${ownerToken}.json`);
        const leaseRecords = await listRecords(paths(config.root).leases, 'lease record', validLease);
        const ticketRecords = await listRecords(paths(config.root).tickets, 'queue ticket', validTicket);
        const tickets = ticketRecords.active.sort((a, b) => a.sequence - b.sequence);
        lastDescription = describe(leaseRecords.active, tickets, config.capacityUnits);
        const position = tickets.findIndex((ticket) => ticket.ownerToken === ownerToken);
        if (position < 0) throw new CapacityCoordinationError('This job queue ticket disappeared before admission; refusing to continue.');
        const used = leaseRecords.active.reduce((total, lease) => total + lease.weight, 0);
        if (position !== 0 || used + config.leaseWeight > config.capacityUnits) return null;

        const leasePath = join(paths(config.root).leases, `${ownerToken}.json`);
        await writeExclusive(leasePath, JSON.stringify({ ...metadata, ownerToken, weight: config.leaseWeight, acquiredAt: new Date(now()).toISOString() }));
        await removeRegularRecord(ticketPath, 'queue ticket');
        return { leasePath };
      });
      if (result) return { ownerToken, ...result };
      if (now() >= deadline) throw new CapacityCoordinationError(`Timed out after ${Math.ceil(config.timeoutMs / 1000)}s waiting for physical-host capacity (${lastDescription}). Existing lease or queue records are never reclaimed automatically; follow the documented manual recovery procedure after confirming no owner is live.`);
      await sleep(Math.min(config.pollIntervalMs, Math.max(1, deadline - now())));
    }
  } catch (error) {
    if (ticketCreated) {
      try {
        await removeTicket(config, ownerToken, { now, sleep });
      } catch (cleanupError) {
        throw new CapacityCoordinationError(`${error.message} Queue ticket cleanup also failed: ${cleanupError.message}`, cleanupError);
      }
    }
    throw error;
  }
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
      await removeRegularRecord(leasePath, 'lease record');
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

export async function recoverAbandonedRecord(config, { kind, ownerToken, now = realClock.now, sleep = realClock.sleep } = {}) {
  await ensureProvisioned(config);
  const location = paths(config.root);
  if (kind === 'control') {
    if (ownerToken !== 'active') throw new CapacityCoordinationError('Control recovery can target only the active control directory.');
    await assertDirectory(location.controlTickets, 'control-ticket directory');
    const controlPath = join(location.controlTickets, 'active');
    await assertDirectory(controlPath, 'active control-ticket directory');
    await rm(controlPath, { recursive: true, force: false });
    return controlPath;
  }
  if (!['lease', 'ticket'].includes(kind) || !/^[a-f0-9-]{36}$/i.test(ownerToken ?? '')) {
    throw new CapacityCoordinationError('Recovery requires kind lease or ticket and a UUID owner token.');
  }
  const directory = kind === 'lease' ? location.leases : location.tickets;
  const label = kind === 'lease' ? 'lease record' : 'queue ticket';
  const validate = kind === 'lease' ? validLease : validTicket;
  const recordPath = join(directory, `${ownerToken}.json`);
  const cleanup = { ...config, timeoutMs: Math.max(CLEANUP_RETRY_MS, config.pollIntervalMs), now, sleep };
  return withControlLock(config.root, cleanup, async () => {
    const record = validate(await readJson(recordPath, label), recordPath);
    if (record.ownerToken !== ownerToken) throw new CapacityCoordinationError(`Recovery target ownership mismatch at ${recordPath}.`);
    await removeRegularRecord(recordPath, label);
    return recordPath;
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
