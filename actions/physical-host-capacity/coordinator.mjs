import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

const STATE_DIRECTORY = '.kontour-physical-host-capacity';
const LEASE_DIRECTORY = 'leases';
const TICKET_DIRECTORY = 'tickets';
const CONTROL_TICKET_DIRECTORY = 'control-tickets';
const QUEUE_SEQUENCE_DIRECTORY = 'queue-sequences';
const STAGING_DIRECTORY = 'staging';
const MANIFEST_FILE = 'host-manifest.json';
const HOST_MARKER_FILE = '.kontour-physical-host-id';
const MANIFEST_SCHEMA_VERSION = 7;
const RECOVERY_STRATEGY = 'bounded-owner-deadline-v1';
const LEGACY_MANIFEST_SCHEMA_VERSION = 6;
const LEGACY_RECOVERY_STRATEGY = 'explicit-quiesced-recovery-v1';
const LEGACY_OWNER_LIFETIME_FLOOR_MS = 6_000_000;
const CLEANUP_RETRY_MS = 5_000;
const MAX_DIAGNOSTIC_ENTRIES = 6;
const MAX_DIAGNOSTIC_VALUE_LENGTH = 120;
const CONTROL_METADATA_FIELDS = ['repository', 'runId', 'runAttempt', 'workflow', 'job', 'runnerName'];

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
  const githubKey = `INPUT_${name.toUpperCase()}`;
  const portableKey = `INPUT_${name.replaceAll('-', '_').toUpperCase()}`;
  const githubValue = env[githubKey];
  const portableValue = env[portableKey];
  if (
    githubKey !== portableKey &&
    githubValue !== undefined &&
    portableValue !== undefined &&
    githubValue !== portableValue
  ) {
    throw new CapacityCoordinationError(
      `${name} has conflicting GitHub and portable input values.`,
    );
  }
  return githubValue ?? portableValue;
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
  const ownerLifetime = durationMilliseconds(input(env, 'owner-lifetime-seconds') ?? env.PHYSICAL_HOST_CAPACITY_OWNER_LIFETIME_SECONDS ?? '6000', 'owner-lifetime-seconds');

  if (leaseWeight > capacityUnits) throw new CapacityCoordinationError(`lease-weight (${leaseWeight}) cannot exceed capacity-units (${capacityUnits}).`);

  return {
    root, hostId, capacityUnits, leaseWeight, timeoutMs, pollIntervalMs,
    ownerLifetimeSeconds: ownerLifetime.seconds, ownerLifetimeMs: ownerLifetime.milliseconds,
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
    queueSequences: join(state, QUEUE_SEQUENCE_DIRECTORY),
    staging: join(state, STAGING_DIRECTORY),
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
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function publishJson(path, contents, stagingDirectory) {
  const temporaryPath = join(stagingDirectory, `${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
  try {
    await assertRegularFile(path, 'existing capacity record');
    throw new CapacityCoordinationError(`Capacity record already exists at ${path}; refusing to replace it.`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
  try {
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
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
    ownerLifetimeSeconds: config.ownerLifetimeSeconds,
    recoveryStrategy: RECOVERY_STRATEGY,
  };
}

function validManifest(manifest, path) {
  const expectedKeys = ['capacityUnits', 'hostId', 'ownerLifetimeSeconds', 'recoveryStrategy', 'schemaVersion'];
  const legacyKeys = ['capacityUnits', 'hostId', 'recoveryStrategy', 'schemaVersion'];
  if (
    manifest && typeof manifest === 'object' && !Array.isArray(manifest) &&
    Object.keys(manifest).sort().join(',') === legacyKeys.join(',') &&
    manifest.schemaVersion === LEGACY_MANIFEST_SCHEMA_VERSION &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.hostId) &&
    Number.isSafeInteger(manifest.capacityUnits) && manifest.capacityUnits >= 1 &&
    manifest.recoveryStrategy === LEGACY_RECOVERY_STRATEGY
  ) return { ...manifest, legacy: true };
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).sort().join(',') !== expectedKeys.join(',')) {
    throw new CapacityCoordinationError(`Invalid host manifest at ${path}; refusing to guess capacity configuration.`);
  }
  if (
    manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.hostId) ||
    !Number.isSafeInteger(manifest.capacityUnits) || manifest.capacityUnits < 1 ||
    !Number.isSafeInteger(manifest.ownerLifetimeSeconds) || manifest.ownerLifetimeSeconds < 1 ||
    manifest.recoveryStrategy !== RECOVERY_STRATEGY
  ) throw new CapacityCoordinationError(`Invalid host manifest at ${path}; refusing to guess capacity configuration.`);
  return manifest;
}

function assertManifestMatches(manifest, config, path) {
  if (manifest.legacy) {
    if (manifest.hostId !== config.hostId || manifest.capacityUnits !== config.capacityUnits) {
      throw new CapacityCoordinationError(`Host manifest mismatch at ${path}: legacy host identity or capacity differs from this job. Coordination cannot continue.`);
    }
    return;
  }
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
  await assertDirectory(location.queueSequences, 'queue-sequence directory');
  await assertDirectory(location.staging, 'staging directory');
  const manifest = validManifest(await readJson(location.manifest, 'host manifest'), location.manifest);
  assertManifestMatches(manifest, config, location.manifest);
}

export async function provisionHost(config, { ownerToken = randomUUID() } = {}) {
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
  await createRealDirectory(location.queueSequences, 'queue-sequence directory');
  await createRealDirectory(location.staging, 'staging directory');
  await withControlLock(config.root, { ...config, ownerToken }, async () => {
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
  });
}

function assertOwnerToken(ownerToken, label = 'ownerToken') {
  if (!/^[a-f0-9-]{36}$/i.test(ownerToken ?? '')) throw new CapacityCoordinationError(`${label} must be a UUID.`);
}

function boundedControlMetadata(metadata = {}) {
  return Object.fromEntries(CONTROL_METADATA_FIELDS.map((field) => [field, diagnosticValue(metadata[field])]));
}

function controlOwnerRecord(ownerToken, lockToken, metadata) {
  return {
    ...boundedControlMetadata(metadata),
    ownerToken,
    lockToken,
  };
}

function validControlOwner(record, path) {
  const expectedKeys = ['job', 'lockToken', 'ownerToken', 'repository', 'runAttempt', 'runId', 'runnerName', 'workflow'];
  if (
    !record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',') !== expectedKeys.join(',')
    || !/^[a-f0-9-]{36}$/i.test(record.ownerToken)
    || !/^[a-f0-9-]{36}$/i.test(record.lockToken)
    || CONTROL_METADATA_FIELDS.some((field) => typeof record[field] !== 'string' || record[field].length > MAX_DIAGNOSTIC_VALUE_LENGTH)
  ) {
    throw new CapacityCoordinationError(`Invalid active control ticket at ${path}; refusing to guess or steal control ownership.`);
  }
  return record;
}

async function readControlOwnerRecord(controlPath, { readOperation = readFile } = {}) {
  await assertRegularFile(controlPath, 'active control ticket');
  let raw;
  try {
    raw = await readOperation(controlPath, 'utf8');
  } catch (error) {
    const wrapped = new CapacityCoordinationError(`Unable to read active control ticket at ${controlPath}: ${error.message}`, error);
    wrapped.code = error.code;
    throw wrapped;
  }
  try {
    return validControlOwner(JSON.parse(raw), controlPath);
  } catch (error) {
    if (error instanceof CapacityCoordinationError) throw error;
    throw new CapacityCoordinationError(`Invalid active control ticket at ${controlPath}; refusing to guess or steal control ownership.`, error);
  }
}

async function readActiveControlOwner(controlPath, options) {
  return readControlOwnerRecord(controlPath, options);
}

function errorCode(error) {
  return error?.code ?? error?.cause?.code;
}

async function readActiveControlOwnerWithRetry(controlPath, {
  deadline,
  now,
  sleep,
  pollIntervalMs,
  readOperation,
} = {}) {
  while (true) {
    try {
      return await readActiveControlOwner(controlPath, { readOperation });
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(errorCode(error))) throw error;
      if (now() >= deadline) {
        throw new CapacityCoordinationError(`Timed out waiting to inspect active control ticket at ${controlPath}; transient sharing contention never produced a valid owner record.`, error);
      }
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    }
  }
}

async function publishControlLock(controlTickets, ownerToken, metadata, { linkOperation = link } = {}) {
  const controlPath = join(controlTickets, 'active');
  const lockToken = randomUUID();
  const record = controlOwnerRecord(ownerToken, lockToken, metadata);
  const candidatePath = join(controlTickets, `.candidate-${ownerToken}-${lockToken}.json`);
  let published = false;
  try {
    await writeExclusive(candidatePath, JSON.stringify(record));
    try {
      await linkOperation(candidatePath, controlPath);
      published = true;
      // Keep this link while the protected operation runs. It is an immutable
      // inode witness for this exact lock instance, not merely this owner.
      return { candidatePath, record };
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) return false;
      // Preserve the failed-link reason. The caller must distinguish a real
      // active owner from an NTFS sharing denial with no active entry.
      if (['EPERM', 'EACCES'].includes(error.code)) return { accessError: error };
      throw error;
    }
  } finally {
    if (!published) await rm(candidatePath, { force: true });
  }
}

function sameControlLock(left, right) {
  return left.ownerToken === right.ownerToken && left.lockToken === right.lockToken;
}

function candidateControlPath(controlTickets, owner) {
  return join(controlTickets, `.candidate-${owner.ownerToken}-${owner.lockToken}.json`);
}

function retiredControlPath(controlTickets, ownerToken) {
  // One action invocation owns one UUID. Keeping this name independent of the
  // lock instance means its post step has an exact, bounded recovery target
  // even if the process died after unlinking active.
  return join(controlTickets, `.retired-${ownerToken}.json`);
}

async function assertActiveControlLockInstance(controlPath, candidatePath, expectedOwner, {
  readOperation = readFile,
  readOwner = (path) => readActiveControlOwner(path, { readOperation }),
} = {}) {
  let activeOwner;
  let activeInfo;
  let candidateInfo;
  try {
    [activeOwner, activeInfo, candidateInfo] = await Promise.all([
      readOwner(controlPath),
      stat(controlPath),
      stat(candidatePath),
    ]);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw new CapacityCoordinationError(`Active control ticket at ${controlPath} no longer references this lock instance inode; refusing to enter protected work.`, error);
    }
    throw error;
  }
  if (!sameControlLock(activeOwner, expectedOwner)) {
    throw new CapacityCoordinationError(`Active control ticket at ${controlPath} no longer identifies this lock instance; refusing to enter protected work.`);
  }
  if (activeInfo.dev !== candidateInfo.dev || activeInfo.ino !== candidateInfo.ino) {
    throw new CapacityCoordinationError(`Active control ticket at ${controlPath} no longer references this lock instance inode; refusing to enter protected work.`);
  }
  return activeOwner;
}

async function retireActiveControlLock(controlTickets, expectedOwner, {
  controlHooks = {},
  candidatePath,
  readOperation = readFile,
  inspectActive = readActiveControlOwner,
} = {}) {
  const controlPath = join(controlTickets, 'active');
  const retiredPath = retiredControlPath(controlTickets, expectedOwner.ownerToken);
  let claimed = false;
  let unlinkedActive = false;
  try {
    await link(controlPath, retiredPath);
    claimed = true;
  } catch (error) {
    if (['EEXIST', 'ENOENT'].includes(error.code)) return false;
    throw error;
  }
  try {
    // Linking active to a deterministic retired name atomically claims this
    // exact inode. A second cleaner sees EEXIST and must not unlink active.
    const claimedOwner = await readControlOwnerRecord(retiredPath);
    if (!sameControlLock(claimedOwner, expectedOwner)) return false;
    await controlHooks.afterControlRetireClaim?.(expectedOwner);
    try {
      if (candidatePath) {
        // First retain the claim proof, then re-read the current directory
        // entry. A replacement between those checks must survive untouched.
        await assertActiveControlLockInstance(retiredPath, candidatePath, expectedOwner, { readOperation });
        await assertActiveControlLockInstance(controlPath, candidatePath, expectedOwner, { readOperation, readOwner: inspectActive });
      } else {
        await assertActiveControlLockInstance(controlPath, retiredPath, expectedOwner, { readOperation, readOwner: inspectActive });
      }
      await unlink(controlPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
    unlinkedActive = true;
    await controlHooks.afterControlRetire?.(expectedOwner);
    return true;
  } finally {
    // Keep a successful retirement as a bounded recovery index until its
    // candidate is removed. If the process dies in either cleanup step, the
    // post step can find the exact candidate without scanning the directory.
    if (claimed && !unlinkedActive) await rm(retiredPath, { force: true });
  }
}

async function removeExactControlRecord(path, expectedOwner) {
  try {
    const record = await readControlOwnerRecord(path);
    if (!sameControlLock(record, expectedOwner)) return false;
    await rm(path, { force: false });
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function consumeDetachedRetirementBeforePublish(controlTickets, ownerToken) {
  // This is deliberately O(1): never enumerate other owners' abandoned
  // artifacts. A deterministic owner path lets a later same-owner invocation
  // release only a detached retirement index from an interrupted cleanup.
  const retiredPath = retiredControlPath(controlTickets, ownerToken);
  let retiredOwner;
  try {
    retiredOwner = await readControlOwnerRecord(retiredPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  if (retiredOwner.ownerToken !== ownerToken) {
    throw new CapacityCoordinationError(`Retired control ticket at ${retiredPath} has an unexpected owner; refusing cleanup.`);
  }

  try {
    const [activeInfo, retiredInfo] = await Promise.all([
      stat(join(controlTickets, 'active')),
      stat(retiredPath),
    ]);
    // A live retirement fence still names active's exact inode. It cannot be
    // invalidated by a contender, even if that contender shares ownerToken.
    if (activeInfo.dev === retiredInfo.dev && activeInfo.ino === retiredInfo.ino) return;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }

  // There is no active link to this retirement inode. Remove only its exact
  // matching candidate and index; a different instance at either path is
  // never adopted or deleted.
  await removeExactControlRecord(candidateControlPath(controlTickets, retiredOwner), retiredOwner);
  await removeExactControlRecord(retiredPath, retiredOwner);
}

async function withControlLock(root, {
  timeoutMs,
  pollIntervalMs,
  now = realClock.now,
  sleep = realClock.sleep,
  ownerToken,
  metadata = {},
  linkOperation = link,
  readOperation = readFile,
  controlHooks,
}, operation) {
  // A fully synced candidate file is atomically hard-linked to `active`. A
  // cancellation can therefore leave a known owner, but never an empty lock.
  assertOwnerToken(ownerToken, 'control lock ownerToken');
  const controlTickets = paths(root).controlTickets;
  const controlPath = join(controlTickets, 'active');
  const deadline = now() + timeoutMs;
  const inspectActive = (path = controlPath) => readActiveControlOwnerWithRetry(path, {
    deadline, now, sleep, pollIntervalMs, readOperation,
  });
  while (true) {
    await consumeDetachedRetirementBeforePublish(controlTickets, ownerToken);
    const publication = await publishControlLock(controlTickets, ownerToken, metadata, { linkOperation });
    if (publication?.record) {
      const heldOwner = publication.record;
      await controlHooks?.afterControlPublish?.(heldOwner, controlPath, publication.candidatePath);
      let retired = false;
      let operationError;
      try {
        await assertActiveControlLockInstance(controlPath, publication.candidatePath, heldOwner, { readOperation, readOwner: inspectActive });
        await controlHooks?.beforeControlOperation?.(heldOwner, controlPath, publication.candidatePath);
        return await operation();
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        try {
          retired = await retireActiveControlLock(controlTickets, heldOwner, {
            controlHooks,
            candidatePath: publication.candidatePath,
            readOperation,
            inspectActive,
          });
          if (!retired) throw new CapacityCoordinationError(`Active control ticket at ${controlPath} changed before its owner could release it; refusing to remove another owner's lock.`);
        } catch (cleanupError) {
          // Preserve the original proof/operation failure. A replacement lock
          // must remain untouched, but it must not hide why protected work
          // was refused in the first place.
          if (!operationError) throw cleanupError;
        } finally {
          await rm(publication.candidatePath, { force: true });
          if (retired) await removeExactControlRecord(retiredControlPath(controlTickets, heldOwner.ownerToken), heldOwner);
        }
      }
    }
    let owner;
    try {
      owner = await inspectActive(controlPath);
    } catch (inspectionError) {
      // The owner can release between a failed publish and inspection. That
      // is a normal handoff; malformed or redirected locks fail closed.
      if (errorCode(inspectionError) === 'ENOENT') {
        if (publication?.accessError) {
          if (now() >= deadline) {
            throw new CapacityCoordinationError(`Timed out publishing the capacity control ticket at ${controlPath}; native sharing contention never produced an active owner record.`, publication.accessError);
          }
          await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
        }
        continue;
      }
      throw inspectionError;
    }
    if (owner.ownerToken === ownerToken) {
      const retired = await retireActiveControlLock(controlTickets, owner, { controlHooks, readOperation, inspectActive });
      if (retired) {
        await removeExactControlRecord(candidateControlPath(controlTickets, owner), owner);
        await removeExactControlRecord(retiredControlPath(controlTickets, owner.ownerToken), owner);
        continue;
      }
      if (now() >= deadline) throw new CapacityCoordinationError(`Timed out waiting for same-owner control cleanup at ${controlPath}; an exact cleanup is already in progress for ${diagnosticIdentity(owner)}.`);
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
      continue;
    }
    if (now() >= deadline) throw new CapacityCoordinationError(`Timed out waiting for the capacity coordination control ticket; it belongs to a different owner (${diagnosticIdentity(owner)}) and automatic control-ticket stealing is disabled, so use the documented manual recovery procedure after confirming no owner is live.`);
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
}

function validLease(record, path) {
  if (!record || !/^[a-f0-9-]{36}$/i.test(record.ownerToken) || !Number.isSafeInteger(record.weight) || record.weight < 1 || typeof record.acquiredAt !== 'string' || (record.expiresAt !== undefined && Number.isNaN(Date.parse(record.expiresAt)))) {
    throw new CapacityCoordinationError(`Invalid lease record at ${path}; refusing to guess capacity state.`);
  }
  return record;
}

function validTicket(record, path) {
  if (!record || !/^[a-f0-9-]{36}$/i.test(record.ownerToken) || !Number.isSafeInteger(record.weight) || record.weight < 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || (record.expiresAt !== undefined && Number.isNaN(Date.parse(record.expiresAt)))) {
    throw new CapacityCoordinationError(`Invalid queue ticket at ${path}; refusing to guess capacity state.`);
  }
  return record;
}

async function listRecords(directory, label, validate, config, now) {
  const entries = await readdir(directory, { withFileTypes: true });
  const active = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw new CapacityCoordinationError(`Unexpected ${label} entry at ${path}; refusing to guess capacity state.`);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new CapacityCoordinationError(`Unexpected ${label} entry at ${path}; refusing to follow a symlink or junction.`);
    const record = validate(await readJson(path, label), path);
    // v6 did not persist an owner deadline. Its mtime fallback therefore uses
    // the Station-wide 90-minute timeout plus margin floor, even when a caller
    // supplies a shorter value during migration.
    const expiry = record.expiresAt ? Date.parse(record.expiresAt) : info.mtimeMs + Math.max(config.ownerLifetimeMs, LEGACY_OWNER_LIFETIME_FLOOR_MS);
    if (expiry <= now()) {
      await removeRegularRecord(path, label);
      continue;
    }
    active.push({ ...record, path });
  }
  return { active };
}

function summarize(records, format) {
  const shown = records.slice(0, MAX_DIAGNOSTIC_ENTRIES).map(format);
  const omitted = records.length - shown.length;
  return `${shown.join('; ') || 'none'}${omitted > 0 ? `; omitted=${omitted}` : ''}`;
}

function diagnosticValue(value) {
  if (typeof value !== 'string' || value.trim() === '') return 'unknown';
  const normalized = value.trim();
  if (normalized.length <= MAX_DIAGNOSTIC_VALUE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH - 3)}...`;
}

function diagnosticIdentity(record) {
  const value = (name) => JSON.stringify(diagnosticValue(record[name]));
  return `repo=${value('repository')} run=${value('runId')}/${value('runAttempt')} workflow=${value('workflow')} job=${value('job')} runner=${value('runnerName')}`;
}

function describe(leases, tickets, capacityUnits) {
  const used = leases.reduce((total, lease) => total + lease.weight, 0);
  return `used=${used}/${capacityUnits}; leases=${summarize(leases, (lease) => `${lease.ownerToken.slice(0, 8)} weight=${lease.weight} ${diagnosticIdentity(lease)}`)}; queue=${summarize(tickets, (ticket) => `${ticket.ownerToken.slice(0, 8)} weight=${ticket.weight} sequence=${ticket.sequence} ${diagnosticIdentity(ticket)}`)}`;
}

function recordWithMetadata(metadata, authoritativeFields) {
  return { ...metadata, ...authoritativeFields };
}

async function createTicket(config, ownerToken, now, metadata) {
  const location = paths(config.root);
  const entries = await readdir(location.queueSequences, { withFileTypes: true });
  let maximum = 0n;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]{20}$/.test(entry.name)) {
      throw new CapacityCoordinationError(`Invalid queue-sequence entry at ${join(location.queueSequences, entry.name)}; refusing to guess FIFO order.`);
    }
    const info = await lstat(join(location.queueSequences, entry.name));
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new CapacityCoordinationError(`Invalid queue-sequence entry at ${join(location.queueSequences, entry.name)}; refusing to follow a symlink or junction.`);
    }
    maximum = BigInt(entry.name) > maximum ? BigInt(entry.name) : maximum;
  }
  const sequence = maximum + 1n;
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) throw new CapacityCoordinationError('Queue sequence has exceeded safe integer range.');
  await mkdir(join(location.queueSequences, sequence.toString().padStart(20, '0')));
  const ticketPath = join(location.tickets, `${ownerToken}.json`);
  const acquiredAt = new Date(now()).toISOString();
  const expiresAt = new Date(now() + config.ownerLifetimeMs).toISOString();
  await publishJson(
    ticketPath,
    JSON.stringify(recordWithMetadata(metadata, {
      ownerToken,
      weight: config.leaseWeight,
      sequence: Number(sequence),
      acquiredAt,
      expiresAt,
    })),
    location.staging,
  );
  return ticketPath;
}

async function removeTicket(config, ownerToken, {
  now = realClock.now,
  sleep = realClock.sleep,
  metadata = {},
  linkOperation = link,
  controlReadOperation = readFile,
  controlHooks,
} = {}) {
  const cleanup = { ...config, timeoutMs: Math.max(CLEANUP_RETRY_MS, config.pollIntervalMs), now, sleep };
  return withControlLock(config.root, { ...cleanup, ownerToken, metadata, linkOperation, readOperation: controlReadOperation, controlHooks }, async () => {
    try {
      await removeRegularRecord(join(paths(config.root).tickets, `${ownerToken}.json`), 'queue ticket');
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

export async function acquireLease(config, {
  ownerToken = randomUUID(),
  now = realClock.now,
  sleep = realClock.sleep,
  metadata = {},
  controlLinkOperation = link,
  controlReadOperation = readFile,
  controlHooks,
} = {}) {
  assertOwnerToken(ownerToken);
  await ensureProvisioned(config);
  const deadline = now() + config.timeoutMs;
  let lastDescription = 'no capacity check completed';
  let ticketCreated = false;

  try {
    await withControlLock(config.root, { ...config, timeoutMs: config.timeoutMs, now, sleep, ownerToken, metadata, linkOperation: controlLinkOperation, readOperation: controlReadOperation, controlHooks }, async () => {
      await createTicket(config, ownerToken, now, metadata);
      ticketCreated = true;
    });
    while (true) {
      const remaining = Math.max(0, deadline - now());
      const result = await withControlLock(config.root, { ...config, timeoutMs: remaining, now, sleep, ownerToken, metadata, linkOperation: controlLinkOperation, readOperation: controlReadOperation, controlHooks }, async () => {
        const ticketPath = join(paths(config.root).tickets, `${ownerToken}.json`);
        const leaseRecords = await listRecords(paths(config.root).leases, 'lease record', validLease, config, now);
        const ticketRecords = await listRecords(paths(config.root).tickets, 'queue ticket', validTicket, config, now);
        const tickets = ticketRecords.active.sort((a, b) => a.sequence - b.sequence);
        lastDescription = describe(leaseRecords.active, tickets, config.capacityUnits);
        const position = tickets.findIndex((ticket) => ticket.ownerToken === ownerToken);
        if (position < 0) throw new CapacityCoordinationError('This job queue ticket disappeared before admission; refusing to continue.');
        const used = leaseRecords.active.reduce((total, lease) => total + lease.weight, 0);
        if (position !== 0 || used + config.leaseWeight > config.capacityUnits) return null;

        const leasePath = join(paths(config.root).leases, `${ownerToken}.json`);
        const acquiredAt = new Date(now()).toISOString();
        const expiresAt = new Date(now() + config.ownerLifetimeMs).toISOString();
        await publishJson(
          leasePath,
          JSON.stringify(recordWithMetadata(metadata, {
            ownerToken,
            weight: config.leaseWeight,
            acquiredAt,
            expiresAt,
          })),
          paths(config.root).staging,
        );
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
        await removeTicket(config, ownerToken, { now, sleep, metadata, linkOperation: controlLinkOperation, controlReadOperation, controlHooks });
      } catch (cleanupError) {
        throw new CapacityCoordinationError(`${error.message} Queue ticket cleanup also failed: ${cleanupError.message}`, cleanupError);
      }
    }
    throw error;
  }
}

export async function releaseLease(config, ownerToken, {
  now = realClock.now,
  sleep = realClock.sleep,
  metadata = {},
  controlLinkOperation = link,
  controlReadOperation = readFile,
  controlHooks,
} = {}) {
  assertOwnerToken(ownerToken);
  await ensureProvisioned(config);
  const cleanup = { ...config, timeoutMs: Math.max(CLEANUP_RETRY_MS, config.pollIntervalMs), now, sleep };
  return withControlLock(config.root, { ...cleanup, ownerToken, metadata, linkOperation: controlLinkOperation, readOperation: controlReadOperation, controlHooks }, async () => {
      const leasePath = join(paths(config.root).leases, `${ownerToken}.json`);
      const ticketPath = join(paths(config.root).tickets, `${ownerToken}.json`);
      let releasedLease = false;
      try {
        const lease = validLease(await readJson(leasePath, 'lease record'), leasePath);
        if (lease.ownerToken !== ownerToken) throw new CapacityCoordinationError(`Lease ownership mismatch at ${leasePath}; refusing to release another job's capacity.`);
        await removeRegularRecord(leasePath, 'lease record');
        releasedLease = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      // The post step also runs when acquire.mjs was interrupted while waiting.
      // Its UUID-targeted ticket is safe to remove even though no lease exists.
      try {
        await removeRegularRecord(ticketPath, 'queue ticket');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return releasedLease;
  });
}

export async function recoverAbandonedRecord(config, { kind, ownerToken, expectedSha256, controlOwnerToken = randomUUID(), now = realClock.now, sleep = realClock.sleep } = {}) {
  await ensureProvisioned(config);
  const location = paths(config.root);
  if (kind === 'control') {
    if (ownerToken !== 'active') throw new CapacityCoordinationError('Control recovery can target only the active control directory.');
    const controlPath = join(location.controlTickets, 'active');
    // Quiesced manual recovery remains the escape hatch for a crash-corrupted
    // active record. Automatic callers require a valid owner record.
    const info = await lstat(controlPath);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new CapacityCoordinationError(`active control-ticket entry at ${controlPath} must be a regular file or directory, not a symlink or junction.`);
    }
    await rm(controlPath, { recursive: info.isDirectory(), force: false });
    return controlPath;
  }
  if (kind === 'sequence') {
    if (!/^[0-9]{20}$/.test(ownerToken ?? '')) throw new CapacityCoordinationError('Sequence recovery requires a 20-digit sequence marker.');
    const sequencePath = join(location.queueSequences, ownerToken);
    const cleanup = { ...config, timeoutMs: Math.max(CLEANUP_RETRY_MS, config.pollIntervalMs), now, sleep };
    return withControlLock(config.root, { ...cleanup, ownerToken: controlOwnerToken }, async () => {
      await removeRegularRecord(sequencePath, 'queue-sequence entry');
      return sequencePath;
    });
  }
  if (!['lease', 'ticket'].includes(kind) || !/^[a-f0-9-]{36}$/i.test(ownerToken ?? '')) {
    throw new CapacityCoordinationError('Recovery requires kind lease or ticket and a UUID owner token.');
  }
  const directory = kind === 'lease' ? location.leases : location.tickets;
  const label = kind === 'lease' ? 'lease record' : 'queue ticket';
  const recordPath = join(directory, `${ownerToken}.json`);
  const cleanup = { ...config, timeoutMs: Math.max(CLEANUP_RETRY_MS, config.pollIntervalMs), now, sleep };
  return withControlLock(config.root, { ...cleanup, ownerToken: controlOwnerToken }, async () => {
    if (expectedSha256 !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
        throw new CapacityCoordinationError('Expected recovery record digest must be a lowercase SHA-256 value.');
      }
      await assertRegularFile(recordPath, label);
      const currentSha256 = createHash('sha256')
        .update(await readFile(recordPath))
        .digest('hex');
      if (currentSha256 !== expectedSha256) {
        throw new CapacityCoordinationError(
          `${label} at ${recordPath} changed after owner verification; refusing to recover a replacement record.`,
        );
      }
    }
    // The filename is the exact, UUID-validated recovery target. Do not parse
    // it here: recovery exists specifically to remove a crash-corrupted record.
    await removeRegularRecord(recordPath, label);
    return recordPath;
  });
}

export function actionMetadata(env = process.env) {
  return {
    repository: env.GITHUB_REPOSITORY ?? 'unknown',
    runId: env.GITHUB_RUN_ID ?? 'unknown',
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? 'unknown',
    workflow: env.GITHUB_WORKFLOW ?? 'unknown',
    workflowRef: env.GITHUB_WORKFLOW_REF ?? 'unknown',
    job: env.GITHUB_JOB ?? 'unknown',
    runnerName: env.RUNNER_NAME ?? 'unknown',
    runnerOs: env.RUNNER_OS ?? 'unknown',
  };
}

export function stateName(name) {
  return `PHYSICAL_HOST_CAPACITY_${name}`;
}

export function leaseFileName(path) {
  return basename(path);
}
