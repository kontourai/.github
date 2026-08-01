import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import test from 'node:test';

import {
  CapacityCoordinationError,
  acquireLease,
  parseConfig,
  releaseLease,
} from '../actions/physical-host-capacity/coordinator.mjs';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const OWNER_C = '33333333-3333-4333-8333-333333333333';
const execFile = promisify(execFileCallback);
const acquireScript = fileURLToPath(new URL('../actions/physical-host-capacity/acquire.mjs', import.meta.url));
const releaseScript = fileURLToPath(new URL('../actions/physical-host-capacity/release.mjs', import.meta.url));

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'physical-host-capacity-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function config(root, overrides = {}) {
  return {
    root,
    capacityUnits: 3,
    leaseWeight: 2,
    timeoutMs: 0,
    pollIntervalMs: 1,
    staleAfterMs: 60_000,
    ...overrides,
  };
}

test('configuration rejects ambiguous capacity inputs and accepts environment configuration', () => {
  assert.deepEqual(
    parseConfig({
      PHYSICAL_HOST_CAPACITY_ROOT: '/coordination',
      PHYSICAL_HOST_CAPACITY_UNITS: '4',
      PHYSICAL_HOST_CAPACITY_WEIGHT: '3',
      PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS: '0',
      PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS: '25',
      PHYSICAL_HOST_CAPACITY_STALE_AFTER_SECONDS: '120',
    }),
    {
      root: '/coordination',
      capacityUnits: 4,
      leaseWeight: 3,
      timeoutMs: 0,
      pollIntervalMs: 25,
      staleAfterMs: 120_000,
    },
  );
  assert.throws(
    () => parseConfig({ INPUT_COORDINATION_ROOT: '/coordination', INPUT_CAPACITY_UNITS: '1.5' }),
    /capacity-units must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ INPUT_COORDINATION_ROOT: '/coordination', INPUT_CAPACITY_UNITS: '2', INPUT_LEASE_WEIGHT: '3' }),
    /cannot exceed/,
  );
});

test('weighted capacity blocks a contender and reports active utilization', async () => {
  await withRoot(async (root) => {
    const first = await acquireLease(config(root), { ownerToken: OWNER_A });
    assert.match(first.leasePath, new RegExp(`${OWNER_A}\\.json$`));

    await assert.rejects(
      acquireLease(config(root), { ownerToken: OWNER_B }),
      (error) => error instanceof CapacityCoordinationError && /used=2\/3/.test(error.message) && /active=11111111 weight=2/.test(error.message),
    );

    assert.equal(await releaseLease(config(root), OWNER_A), true);
    assert.equal(await releaseLease(config(root), OWNER_A), false);
  });
});

test('concurrent acquisitions never exceed the weighted capacity', async () => {
  await withRoot(async (root) => {
    const base = config(root, { capacityUnits: 3, leaseWeight: 2, timeoutMs: 100, pollIntervalMs: 2 });
    const results = await Promise.allSettled([
      acquireLease(base, { ownerToken: OWNER_A }),
      acquireLease(base, { ownerToken: OWNER_B }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);

    const successful = results.find((result) => result.status === 'fulfilled');
    await releaseLease(base, successful.value.ownerToken);
  });
});

test('stale lease recovery restores capacity while fresh leases remain protected', async () => {
  await withRoot(async (root) => {
    const leases = join(root, '.kontour-physical-host-capacity', 'leases');
    await mkdir(leases, { recursive: true });
    const stalePath = join(leases, `${OWNER_A}.json`);
    await writeFile(stalePath, JSON.stringify({ ownerToken: OWNER_A, weight: 3, acquiredAt: '2020-01-01T00:00:00.000Z' }));
    const staleDate = new Date(Date.now() - 10_000);
    await utimes(stalePath, staleDate, staleDate);

    const acquired = await acquireLease(config(root, { staleAfterMs: 1 }), { ownerToken: OWNER_B });
    assert.equal(acquired.recovered, 1);
    assert.equal(await releaseLease(config(root, { staleAfterMs: 1 }), OWNER_B), true);

    const freshPath = join(leases, `${OWNER_C}.json`);
    await writeFile(freshPath, JSON.stringify({ ownerToken: OWNER_C, weight: 3, acquiredAt: new Date().toISOString() }));
    await assert.rejects(acquireLease(config(root), { ownerToken: OWNER_B }), /used=3\/3/);
    assert.equal(JSON.parse(await readFile(freshPath, 'utf8')).ownerToken, OWNER_C);
  });
});

test('action entrypoints persist state and release the acquired lease in the post step', async () => {
  await withRoot(async (root) => {
    const output = join(root, 'output');
    const environment = join(root, 'environment');
    const state = join(root, 'state');
    await Promise.all([writeFile(output, ''), writeFile(environment, ''), writeFile(state, '')]);
    const actionEnv = {
      ...process.env,
      INPUT_COORDINATION_ROOT: root,
      INPUT_CAPACITY_UNITS: '1',
      INPUT_LEASE_WEIGHT: '1',
      INPUT_TIMEOUT_SECONDS: '0',
      INPUT_POLL_INTERVAL_MS: '1',
      INPUT_STALE_AFTER_SECONDS: '60',
      GITHUB_OUTPUT: output,
      GITHUB_ENV: environment,
      GITHUB_STATE: state,
      GITHUB_REPOSITORY: 'kontourai/example',
      GITHUB_RUN_ID: '42',
      GITHUB_JOB: 'test',
      RUNNER_OS: 'Linux',
    };
    await execFile(process.execPath, [acquireScript], { env: actionEnv });
    const outputs = Object.fromEntries((await readFile(output, 'utf8')).trim().split('\n').map((line) => line.split('=')));
    await access(outputs['lease-path']);

    const postState = Object.fromEntries((await readFile(state, 'utf8')).trim().split('\n').map((line) => {
      const [name, ...value] = line.split('=');
      return [`STATE_${name}`, value.join('=')];
    }));
    await execFile(process.execPath, [releaseScript], { env: { ...actionEnv, ...postState } });
    await assert.rejects(access(outputs['lease-path']), { code: 'ENOENT' });
  });
});
