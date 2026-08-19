import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { access, appendFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import test from 'node:test';

import {
  CapacityCoordinationError,
  acquireLease,
  parseConfig,
  provisionHost,
  releaseLease,
} from '../actions/physical-host-capacity/coordinator.mjs';
import { runAcquireAction } from '../actions/physical-host-capacity/acquire.mjs';
import { runTerminalRecoveryAction } from '../actions/recover-terminal-capacity-owner/main.mjs';
import { recoverTerminalCapacityOwner } from './recover-terminal-capacity-owner.mjs';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const OWNER_C = '33333333-3333-4333-8333-333333333333';
const LOCK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LOCK_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const execFile = promisify(execFileCallback);
const acquireScript = fileURLToPath(new URL('../actions/physical-host-capacity/acquire.mjs', import.meta.url));
const releaseScript = fileURLToPath(new URL('../actions/physical-host-capacity/release.mjs', import.meta.url));
const recoverScript = fileURLToPath(new URL('./recover-physical-host-capacity.mjs', import.meta.url));

async function withRoot(fn, { provision = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'physical-host-capacity-'));
  try {
    if (provision) await provisionHost(config(root));
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function config(root, overrides = {}) {
  return {
    root,
    hostId: 'desktop-win-01',
    capacityUnits: 3,
    leaseWeight: 2,
    timeoutMs: 0,
    pollIntervalMs: 1,
    ownerLifetimeSeconds: 60,
    ownerLifetimeMs: 60_000,
    ...overrides,
  };
}

test('configuration rejects ambiguous capacity inputs and accepts environment configuration', () => {
  assert.deepEqual(
    parseConfig({
      PHYSICAL_HOST_CAPACITY_ROOT: '/coordination',
      PHYSICAL_HOST_CAPACITY_HOST_ID: 'desktop-win-01',
      PHYSICAL_HOST_CAPACITY_UNITS: '4',
      PHYSICAL_HOST_CAPACITY_WEIGHT: '3',
      PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS: '0',
      PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS: '25',
      PHYSICAL_HOST_CAPACITY_OWNER_LIFETIME_SECONDS: '120',
    }),
    {
      root: resolve('/coordination'),
      hostId: 'desktop-win-01',
      capacityUnits: 4,
      leaseWeight: 3,
      timeoutMs: 0,
      pollIntervalMs: 25,
      ownerLifetimeSeconds: 120,
      ownerLifetimeMs: 120_000,
    },
  );
  assert.deepEqual(
    parseConfig({
      'INPUT_COORDINATION-ROOT': '/coordination',
      'INPUT_HOST-ID': 'desktop-win-01',
      'INPUT_CAPACITY-UNITS': '4',
      'INPUT_LEASE-WEIGHT': '3',
      'INPUT_TIMEOUT-SECONDS': '0',
      'INPUT_POLL-INTERVAL-MS': '25',
      'INPUT_OWNER-LIFETIME-SECONDS': '120',
    }),
    {
      root: resolve('/coordination'),
      hostId: 'desktop-win-01',
      capacityUnits: 4,
      leaseWeight: 3,
      timeoutMs: 0,
      pollIntervalMs: 25,
      ownerLifetimeSeconds: 120,
      ownerLifetimeMs: 120_000,
    },
  );
  assert.throws(
    () =>
      parseConfig({
        'INPUT_COORDINATION-ROOT': '/github',
        INPUT_COORDINATION_ROOT: '/portable',
        'INPUT_HOST-ID': 'desktop-win-01',
      }),
    /coordination-root has conflicting GitHub and portable input values/,
  );
  assert.throws(
    () => parseConfig({ INPUT_COORDINATION_ROOT: '/coordination', INPUT_HOST_ID: 'desktop-win-01', INPUT_CAPACITY_UNITS: '1.5' }),
    /capacity-units must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ INPUT_COORDINATION_ROOT: '/coordination', INPUT_HOST_ID: 'desktop-win-01', INPUT_CAPACITY_UNITS: '2', INPUT_LEASE_WEIGHT: '3' }),
    /cannot exceed/,
  );
});

test('weighted capacity blocks a contender and reports active utilization', async () => {
  await withRoot(async (root) => {
    const first = await acquireLease(config(root), { ownerToken: OWNER_A });
    assert.match(first.leasePath, new RegExp(`${OWNER_A}\\.json$`));

    await assert.rejects(
      acquireLease(config(root), { ownerToken: OWNER_B }),
      (error) => error instanceof CapacityCoordinationError && /used=2\/3/.test(error.message) && /leases=11111111 weight=2/.test(error.message),
    );

    assert.equal(await releaseLease(config(root), OWNER_A), true);
    assert.equal(await releaseLease(config(root), OWNER_A), false);
  });
});

test('concurrent acquisitions never exceed the weighted capacity', async () => {
  await withRoot(async (root) => {
    const base = config(root, { capacityUnits: 3, leaseWeight: 2, timeoutMs: 1_000, pollIntervalMs: 2 });
    const first = acquireLease(base, { ownerToken: OWNER_A });
    const second = acquireLease(base, { ownerToken: OWNER_B });
    const leases = join(root, '.kontour-physical-host-capacity', 'leases');
    let firstWinner;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const files = await readdir(leases);
      if (files.length === 1) {
        firstWinner = files[0].replace(/\.json$/, '');
        break;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 2));
    }
    assert.ok(firstWinner, 'one weighted contender should acquire before capacity is released');
    await releaseLease(base, firstWinner);
    const [firstLease, secondLease] = await Promise.all([first, second]);
    assert.notEqual(firstLease.ownerToken, secondLease.ownerToken);
    await releaseLease(base, firstLease.ownerToken);
    await releaseLease(base, secondLease.ownerToken);
  });
});

test('an orphaned lease is reclaimed only after its declared owner lifetime expires', async () => {
  await withRoot(async (root) => {
    const recoveryConfig = config(root, { capacityUnits: 3, leaseWeight: 3, ownerLifetimeSeconds: 5, ownerLifetimeMs: 5_000 });
    await provisionHost(recoveryConfig);
    let now = 0;
    await acquireLease(recoveryConfig, { ownerToken: OWNER_A, now: () => now });
    now = 4_999;
    await assert.rejects(acquireLease(recoveryConfig, { ownerToken: OWNER_B, now: () => now }), /used=3\/3/);
    now = 5_001; // runner A has exceeded its declared maximum lifetime
    const acquired = await acquireLease(recoveryConfig, { ownerToken: OWNER_B, now: () => now });
    assert.equal(await releaseLease(recoveryConfig, OWNER_B), true);
  }, { provision: false });
});

function githubRunResponse({
  status = 'completed',
  conclusion = 'cancelled',
  repository = 'kontourai/station',
  runId = 30_801_602_143,
  runAttempt = 1,
} = {}) {
  return new Response(
    JSON.stringify({
        id: runId,
        run_attempt: runAttempt,
        status,
        conclusion,
        repository: { full_name: repository },
    }),
    { status: 200 },
  );
}

test('an exact terminal GitHub owner is reclaimed before its age deadline', async () => {
  await withRoot(async (root) => {
    const terminalConfig = config(root, {
      capacityUnits: 3,
      leaseWeight: 3,
      ownerLifetimeSeconds: 6_000,
      ownerLifetimeMs: 6_000_000,
    });
    await provisionHost(terminalConfig);
    await acquireLease(terminalConfig, {
      ownerToken: OWNER_A,
      metadata: {
        repository: 'kontourai/station',
        runId: '30801602143',
        runAttempt: '1',
        workflow: 'CI',
        job: 'full-regression',
        runnerName: 'desktop-win-linux',
      },
    });

    const result = await recoverTerminalCapacityOwner({
      config: terminalConfig,
      kind: 'lease',
      ownerToken: OWNER_A,
      repository: 'kontourai/station',
      runId: '30801602143',
      runAttempt: 1,
      token: 'test-token',
      fetchImpl: async (url) => {
        assert.equal(
          url,
          'https://api.github.com/repos/kontourai/station/actions/runs/30801602143/attempts/1',
        );
        return githubRunResponse();
      },
    });
    assert.match(result.recoveredPath, new RegExp(`${OWNER_A}\\.json$`));
    assert.equal(result.conclusion, 'cancelled');

    const next = await acquireLease(terminalConfig, { ownerToken: OWNER_B });
    assert.equal(next.ownerToken, OWNER_B);
    await releaseLease(terminalConfig, OWNER_B);
  }, { provision: false });
});

test('an exact terminal GitHub owner can recover a FIFO ticket', async () => {
  await withRoot(async (root) => {
    const terminalConfig = config(root);
    const ticketPath = join(
      root,
      '.kontour-physical-host-capacity',
      'tickets',
      `${OWNER_A}.json`,
    );
    await writeFile(
      ticketPath,
      JSON.stringify({
        ownerToken: OWNER_A,
        weight: 2,
        sequence: 1,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        repository: 'kontourai/station',
        runId: '30801602143',
        runAttempt: '1',
      }),
    );
    await recoverTerminalCapacityOwner({
      config: terminalConfig,
      kind: 'ticket',
      ownerToken: OWNER_A,
      repository: 'kontourai/station',
      runId: '30801602143',
      runAttempt: 1,
      token: 'test-token',
      fetchImpl: async () => githubRunResponse(),
    });
    assert.equal(existsSync(ticketPath), false);
  });
});

test('the action refuses proof for a repository outside its token scope', async () => {
  await assert.rejects(
    runTerminalRecoveryAction({
      env: {
        GITHUB_REPOSITORY: 'kontourai/.github',
        'INPUT_OWNER-REPOSITORY': 'kontourai/station',
      },
    }),
    /must equal the invoking GitHub repository/,
  );
});

test('terminal recovery preserves live, mismatched, unavailable, and replaced owners', async () => {
  const cases = [
    {
      name: 'live',
      fetchImpl: async () => githubRunResponse({ status: 'in_progress', conclusion: null }),
      expected: /owner run is in_progress/,
    },
    {
      name: 'mismatched proof',
      fetchImpl: async () => githubRunResponse({ repository: 'kontourai/other' }),
      expected: /did not match/,
    },
    {
      name: 'mismatched run id',
      fetchImpl: async () => githubRunResponse({ runId: 999 }),
      expected: /did not match/,
    },
    {
      name: 'mismatched run attempt',
      fetchImpl: async () => githubRunResponse({ runAttempt: 2 }),
      expected: /did not match/,
    },
    {
      name: 'unavailable API',
      fetchImpl: async () => new Response('', { status: 503 }),
      expected: /HTTP 503/,
    },
    {
      name: 'oversized streamed response',
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      expected: /exceeds its byte contract/,
    },
  ];

  for (const scenario of cases) {
    await withRoot(async (root) => {
      const terminalConfig = config(root, { capacityUnits: 3, leaseWeight: 3 });
      await acquireLease(terminalConfig, {
        ownerToken: OWNER_A,
        metadata: {
          repository: 'kontourai/station',
          runId: '30801602143',
          runAttempt: '1',
        },
      });
      await assert.rejects(
        recoverTerminalCapacityOwner({
          config: terminalConfig,
          kind: 'lease',
          ownerToken: OWNER_A,
          repository: 'kontourai/station',
          runId: '30801602143',
          runAttempt: 1,
          token: 'test-token',
          fetchImpl: scenario.fetchImpl,
        }),
        scenario.expected,
        scenario.name,
      );
      await assert.rejects(
        acquireLease(terminalConfig, { ownerToken: OWNER_B }),
        /used=3\/3/,
      );
      await releaseLease(terminalConfig, OWNER_A);
    });
  }

  await withRoot(async (root) => {
    const terminalConfig = config(root, { capacityUnits: 3, leaseWeight: 3 });
    const first = await acquireLease(terminalConfig, {
      ownerToken: OWNER_A,
      metadata: {
        repository: 'kontourai/station',
        runId: '30801602143',
        runAttempt: '1',
      },
    });
    await assert.rejects(
      recoverTerminalCapacityOwner({
        config: terminalConfig,
        kind: 'lease',
        ownerToken: OWNER_A,
        repository: 'kontourai/station',
        runId: '30801602143',
        runAttempt: 1,
        token: 'test-token',
        fetchImpl: async () => githubRunResponse(),
        beforeRecover: async ({ path }) => {
          await unlink(path);
          await writeFile(
            path,
            JSON.stringify({
              ownerToken: OWNER_A,
              weight: 3,
              acquiredAt: new Date().toISOString(),
              repository: 'kontourai/station',
              runId: '999',
              runAttempt: '1',
            }),
          );
        },
      }),
      /changed after owner verification/,
    );
    assert.equal(existsSync(first.leasePath), true);
  });
});

test('an orphaned FIFO head ticket is reclaimed so a later live waiter can enter', async () => {
  await withRoot(async (root) => {
    const orphanConfig = config(root, { capacityUnits: 1, leaseWeight: 1, ownerLifetimeSeconds: 5, ownerLifetimeMs: 5_000 });
    await provisionHost(orphanConfig);
    const tickets = join(root, '.kontour-physical-host-capacity', 'tickets');
    // This simulates a runner dying after it published the head ticket but
    // before it could acquire capacity. Its sequence is older than B's.
    await writeFile(join(tickets, `${OWNER_A}.json`), JSON.stringify({ ownerToken: OWNER_A, weight: 1, sequence: 1, acquiredAt: new Date(0).toISOString(), expiresAt: new Date(5_000).toISOString() }));
    let now = 5_001;
    const acquired = await acquireLease(orphanConfig, { ownerToken: OWNER_B, now: () => now });
    assert.equal(acquired.ownerToken, OWNER_B);
    assert.equal(await releaseLease(orphanConfig, OWNER_B, { now: () => now }), true);
  }, { provision: false });
});

test('a v6 root honors the 90-minute migration floor before recovering stranded records', async () => {
  await withRoot(async (root) => {
    const legacyConfig = config(root, { capacityUnits: 1, leaseWeight: 1, ownerLifetimeSeconds: 5, ownerLifetimeMs: 5_000 });
    await provisionHost(legacyConfig);
    const state = join(root, '.kontour-physical-host-capacity');
    await writeFile(join(state, 'host-manifest.json'), JSON.stringify({ schemaVersion: 6, hostId: 'desktop-win-01', capacityUnits: 1, recoveryStrategy: 'explicit-quiesced-recovery-v1' }));
    const leases = join(state, 'leases');
    const tickets = join(state, 'tickets');
    await writeFile(join(leases, `${OWNER_A}.json`), JSON.stringify({ ownerToken: OWNER_A, weight: 1, acquiredAt: new Date().toISOString() }));
    await writeFile(join(tickets, `${OWNER_B}.json`), JSON.stringify({ ownerToken: OWNER_B, weight: 1, sequence: 1 }));
    const tooEarly = Date.now() + 5_001;
    await assert.rejects(acquireLease(legacyConfig, { ownerToken: OWNER_C, now: () => tooEarly }), /used=1\/1/);
    const now = Date.now() + 6_000_001;
    const acquired = await acquireLease(legacyConfig, { ownerToken: OWNER_C, now: () => now });
    assert.equal(acquired.ownerToken, OWNER_C);
  }, { provision: false });
});

test('explicit recovery requires a distinct, regular quiescence marker and removes it after use', async () => {
  await withRoot(async (root) => {
    const recoveryConfig = config(root, { capacityUnits: 3, leaseWeight: 3 });
    await provisionHost(recoveryConfig);
    const leasePath = join(root, '.kontour-physical-host-capacity', 'leases', `${OWNER_A}.json`);
    const markerPath = join(root, '.kontour-physical-host-quiesced');
    const permanentMarker = join(root, '.kontour-physical-host-id');
    await writeFile(leasePath, JSON.stringify({ ownerToken: OWNER_A, weight: 3, acquiredAt: '2020-01-01T00:00:00.000Z' }));
    const args = ['--root', root, '--host-id', 'desktop-win-01', '--capacity-units', '3', '--owner-lifetime-seconds', '60', '--recover', `lease:${OWNER_A}`];
    await assert.rejects(execFile(process.execPath, [recoverScript, ...args]), /ENOENT/);
    await access(leasePath);
    await access(permanentMarker); // identity is permanent, but is never recovery proof
    await symlink(permanentMarker, markerPath);
    await assert.rejects(execFile(process.execPath, [recoverScript, ...args]), /regular file, not a symlink or junction/);
    await rm(markerPath);
    await writeFile(markerPath, 'wrong-host\n');
    await assert.rejects(execFile(process.execPath, [recoverScript, ...args]), /Quiescence marker/);
    await access(leasePath);
    await writeFile(markerPath, 'desktop-win-01\n');
    await execFile(process.execPath, [recoverScript, ...args]);
    await assert.rejects(access(leasePath), { code: 'ENOENT' });
    await assert.rejects(access(markerPath), { code: 'ENOENT' });
  }, { provision: false });
});

test('durable FIFO tickets admit an older weighted waiter before a later waiter', async () => {
  await withRoot(async (root) => {
    const fifoConfig = config(root, { capacityUnits: 1, leaseWeight: 1, timeoutMs: 5_000, pollIntervalMs: 2 });
    await provisionHost(fifoConfig);
    await acquireLease(fifoConfig, { ownerToken: OWNER_A });
    const older = acquireLease(fifoConfig, { ownerToken: OWNER_B });
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 15));
    const later = acquireLease(fifoConfig, { ownerToken: OWNER_C });
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 15));

    await releaseLease(fifoConfig, OWNER_A);
    const olderLease = await older;
    await releaseLease(fifoConfig, olderLease.ownerToken);
    const laterLease = await later;
    assert.equal(laterLease.ownerToken, OWNER_C);
  }, { provision: false });
});

test('a zero-timeout contender cleans up its durable ticket with an independent retry budget', async () => {
  await withRoot(async (root) => {
    await acquireLease(config(root), { ownerToken: OWNER_A });
    await assert.rejects(acquireLease(config(root), { ownerToken: OWNER_B }), /Timed out after 0s/);
    assert.deepEqual(await readdir(join(root, '.kontour-physical-host-capacity', 'tickets')), []);
  });
});

function controlRecord(ownerToken, lockToken, metadata = {}) {
  return {
    repository: metadata.repository ?? 'unknown',
    runId: metadata.runId ?? 'unknown',
    runAttempt: metadata.runAttempt ?? 'unknown',
    workflow: metadata.workflow ?? 'unknown',
    job: metadata.job ?? 'unknown',
    runnerName: metadata.runnerName ?? 'unknown',
    ownerToken,
    lockToken,
  };
}

async function publishActiveControlLock(root, ownerToken, lockToken = LOCK_A, metadata = {}) {
  const active = join(root, '.kontour-physical-host-capacity', 'control-tickets', 'active');
  await writeFile(active, JSON.stringify(controlRecord(ownerToken, lockToken, metadata)));
  return active;
}

test('control locks atomically publish immutable ownership before protected work', async () => {
  await withRoot(async (root) => {
    const controls = join(root, '.kontour-physical-host-capacity', 'control-tickets');
    let observed = false;
    const metadata = {
      repository: 'kontourai/station',
      runId: '30765267875',
      runAttempt: '1',
      workflow: 'CI Extended',
      job: 'playwright',
      runnerName: `desktop-win-linux-${'x'.repeat(200)}`,
    };
    const controlHooks = {
      afterControlPublish(activeRecord, activePath) {
        assert.equal(activePath, join(controls, 'active'));
        assert.equal(lstatSync(activePath).isFile(), true);
        assert.deepEqual(activeRecord, JSON.parse(readFileSync(activePath, 'utf8')));
        assert.equal(activeRecord.ownerToken, OWNER_A);
        assert.match(activeRecord.lockToken, /^[a-f0-9-]{36}$/i);
        assert.equal(activeRecord.repository, 'kontourai/station');
        assert.equal(activeRecord.runId, '30765267875');
        assert.equal(activeRecord.runAttempt, '1');
        assert.equal(activeRecord.workflow, 'CI Extended');
        assert.equal(activeRecord.job, 'playwright');
        assert.equal(activeRecord.runnerName.length, 120);
        observed = true;
      },
    };
    const acquired = await acquireLease(config(root), { ownerToken: OWNER_A, metadata, controlHooks });
    assert.equal(observed, true);
    assert.equal(existsSync(join(controls, 'active')), false);
    await releaseLease(config(root), acquired.ownerToken);
  });
});

test('the action post release reclaims a cancelled same-owner control lock and cleans its queue ticket', async () => {
  await withRoot(async (root) => {
    const waitingConfig = config(root, { capacityUnits: 1, leaseWeight: 1, timeoutMs: 5_000, pollIntervalMs: 2 });
    await provisionHost(waitingConfig);
    const state = join(root, '.kontour-physical-host-capacity');
    const ticket = join(state, 'tickets', `${OWNER_C}.json`);
    await writeFile(ticket, JSON.stringify({
      ownerToken: OWNER_C,
      weight: 1,
      sequence: 1,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const active = await publishActiveControlLock(root, OWNER_C, LOCK_C);

    const post = await execFile(process.execPath, [releaseScript], {
      env: {
        ...process.env,
        STATE_PHYSICAL_HOST_CAPACITY_ROOT: root,
        STATE_PHYSICAL_HOST_CAPACITY_HOST_ID: 'desktop-win-01',
        STATE_PHYSICAL_HOST_CAPACITY_CAPACITY_UNITS: '1',
        STATE_PHYSICAL_HOST_CAPACITY_LEASE_WEIGHT: '1',
        STATE_PHYSICAL_HOST_CAPACITY_TIMEOUT_SECONDS: '5000',
        STATE_PHYSICAL_HOST_CAPACITY_POLL_INTERVAL_MS: '2',
        STATE_PHYSICAL_HOST_CAPACITY_OWNER_LIFETIME_SECONDS: '60',
        STATE_PHYSICAL_HOST_CAPACITY_OWNER_TOKEN: OWNER_C,
      },
    });
    assert.match(post.stdout, /lease 33333333 was already absent/);
    assert.equal(existsSync(ticket), false);
    assert.equal(existsSync(active), false);
  }, { provision: false });
});

test('a different owner cannot steal an active control lock', async () => {
  await withRoot(async (root) => {
    const active = await publishActiveControlLock(root, OWNER_A, LOCK_A);

    let now = Date.now();
    await assert.rejects(
      acquireLease(config(root), {
        ownerToken: OWNER_B,
        now: () => now,
        sleep: async () => { now += 10_000; },
      }),
      /belongs to a different owner.*automatic control-ticket stealing is disabled/,
    );
    assert.equal(JSON.parse(await readFile(active, 'utf8')).ownerToken, OWNER_A);
    await rm(active, { force: true }); // explicit operator recovery after confirming no owner is live
    const acquired = await acquireLease(config(root), { ownerToken: OWNER_B });
    assert.equal(acquired.ownerToken, OWNER_B);
  });
});

test('a malformed active control lock fails closed', async () => {
  await withRoot(async (root) => {
    const controls = join(root, '.kontour-physical-host-capacity', 'control-tickets');
    await writeFile(join(controls, 'active'), '{');
    await assert.rejects(
      acquireLease(config(root), { ownerToken: OWNER_B }),
      /Invalid active control ticket/,
    );
  });
  await withRoot(async (root) => {
    const controls = join(root, '.kontour-physical-host-capacity', 'control-tickets');
    const replacement = join(root, 'control-ticket-replacement');
    await writeFile(replacement, JSON.stringify(controlRecord(OWNER_A, LOCK_A)));
    await symlink(replacement, join(controls, 'active'));
    await assert.rejects(
      acquireLease(config(root), { ownerToken: OWNER_B }),
      /active control ticket.*regular file, not a symlink or junction/,
    );
  });
});

test('native Windows-style EPERM contention is accepted only after a valid active lock inspection', async () => {
  await withRoot(async (root) => {
    const controls = join(root, '.kontour-physical-host-capacity', 'control-tickets');
    const foreignCandidate = join(controls, 'foreign-candidate.json');
    await writeFile(foreignCandidate, JSON.stringify(controlRecord(OWNER_A, LOCK_A, { repository: 'kontourai/station' })));

    await assert.rejects(
      acquireLease(config(root), {
        ownerToken: OWNER_B,
        controlLinkOperation: async (candidatePath, activePath) => {
          await link(foreignCandidate, activePath);
          const error = new Error(`EPERM native contention for ${candidatePath}`);
          error.code = 'EPERM';
          throw error;
        },
      }),
      /belongs to a different owner.*kontourai\/station/,
    );
    assert.equal(JSON.parse(await readFile(join(controls, 'active'), 'utf8')).ownerToken, OWNER_A);
  });
});

test('native Windows-style EPERM publishing without active owner is deadline-bounded', async () => {
  await withRoot(async (root) => {
    let now = 0;
    let sleeps = 0;
    let attempts = 0;
    await assert.rejects(
      acquireLease(config(root, { timeoutMs: 10, pollIntervalMs: 1 }), {
        ownerToken: OWNER_A,
        now: () => now,
        sleep: async () => {
          sleeps += 1;
          now += 10;
        },
        controlLinkOperation: async () => {
          attempts += 1;
          const error = new Error('EPERM persistent native sharing publish');
          error.code = 'EPERM';
          throw error;
        },
      }),
      /Timed out publishing the capacity control ticket/,
    );
    assert.equal(attempts, 2);
    assert.equal(sleeps, 1);
    assert.equal(existsSync(join(root, '.kontour-physical-host-capacity', 'control-tickets', 'active')), false);
  });
});

test('native Windows-style EPERM while reading active is retried, then fails closed at deadline', async () => {
  await withRoot(async (root) => {
    const active = join(root, '.kontour-physical-host-capacity', 'control-tickets', 'active');
    let remainingFailures = 1;
    const transientRead = async (path, encoding) => {
      if (path === active && remainingFailures > 0) {
        remainingFailures -= 1;
        const error = new Error('EPERM native sharing read');
        error.code = 'EPERM';
        throw error;
      }
      return readFile(path, encoding);
    };
    const acquired = await acquireLease(config(root, { timeoutMs: 100 }), {
      ownerToken: OWNER_A,
      controlReadOperation: transientRead,
    });
    assert.equal(acquired.ownerToken, OWNER_A);
    await releaseLease(config(root, { timeoutMs: 100 }), OWNER_A, { controlReadOperation: transientRead });
  });

  await withRoot(async (root) => {
    const active = join(root, '.kontour-physical-host-capacity', 'control-tickets', 'active');
    let now = 0;
    const deniedRead = async (path, encoding) => {
      if (path === active) {
        const error = new Error('EPERM persistent native sharing read');
        error.code = 'EPERM';
        throw error;
      }
      return readFile(path, encoding);
    };
    await assert.rejects(
      acquireLease(config(root, { timeoutMs: 10, pollIntervalMs: 1 }), {
        ownerToken: OWNER_A,
        now: () => now,
        sleep: async () => { now += 10; },
        controlReadOperation: deniedRead,
      }),
      /Timed out waiting to inspect active control ticket/,
    );
    assert.equal(existsSync(active), true);
    await releaseLease(config(root), OWNER_A);
  });
});

test('protected operation errors are not reclassified as contention or replayed', async () => {
  await withRoot(async (root) => {
    let invocations = 0;
    const expected = new Error('simulated protected EEXIST');
    expected.code = 'EEXIST';
    await assert.rejects(
      acquireLease(config(root), {
        ownerToken: OWNER_A,
        controlHooks: {
          beforeControlOperation() {
            invocations += 1;
            throw expected;
          },
        },
      }),
      (error) => error === expected,
    );
    assert.equal(invocations, 1);
    assert.equal(existsSync(join(root, '.kontour-physical-host-capacity', 'control-tickets', 'active')), false);
    assert.deepEqual(await readdir(join(root, '.kontour-physical-host-capacity', 'tickets')), []);
  });
});

test('a same-owner replacement with identical JSON cannot enter or release protected work', async () => {
  await withRoot(async (root) => {
    const controls = join(root, '.kontour-physical-host-capacity', 'control-tickets');
    const active = join(controls, 'active');
    const replacement = join(root, 'same-owner-replacement.json');
    let operations = 0;

    await assert.rejects(
      acquireLease(config(root), {
        ownerToken: OWNER_A,
        controlHooks: {
          async afterControlPublish(expectedOwner, activePath, candidatePath) {
            assert.equal(activePath, active);
            assert.equal(existsSync(candidatePath), true);
            await writeFile(replacement, JSON.stringify(expectedOwner));
            await unlink(activePath);
            await link(replacement, activePath);
          },
          beforeControlOperation() {
            operations += 1;
          },
        },
      }),
      /no longer references this lock instance inode/,
    );
    assert.equal(operations, 0);
    assert.equal(JSON.parse(await readFile(active, 'utf8')).ownerToken, OWNER_A);
    assert.equal(JSON.parse(await readFile(active, 'utf8')).lockToken.length, 36);
  });
});

test('a same-owner post cleanup followed by a new publisher cannot enter old protected work', async () => {
  await withRoot(async (root) => {
    const active = join(root, '.kontour-physical-host-capacity', 'control-tickets', 'active');
    let operations = 0;

    await assert.rejects(
      acquireLease(config(root), {
        ownerToken: OWNER_A,
        controlHooks: {
          async afterControlPublish() {
            assert.equal(await releaseLease(config(root), OWNER_A), false);
            await publishActiveControlLock(root, OWNER_A, LOCK_B);
          },
          beforeControlOperation() {
            operations += 1;
          },
        },
      }),
      /no longer references this lock instance inode|no longer identifies this lock instance|changed before its owner could release/,
    );
    assert.equal(operations, 0);
    assert.equal(JSON.parse(await readFile(active, 'utf8')).lockToken, LOCK_B);
  });
});

test('an active replacement after retirement claim survives the losing cleaner', async () => {
  await withRoot(async (root) => {
    const controls = join(root, '.kontour-physical-host-capacity', 'control-tickets');
    const active = join(controls, 'active');
    let now = 0;

    await assert.rejects(
      acquireLease(config(root), {
        ownerToken: OWNER_A,
        now: () => now,
        sleep: async () => { now += 6_000; },
        controlHooks: {
          async afterControlRetireClaim() {
            await unlink(active);
            await publishActiveControlLock(root, OWNER_B, LOCK_B);
          },
        },
      }),
      /no longer identifies this lock instance|no longer references this lock instance|Queue ticket cleanup also failed/,
    );
    assert.equal(JSON.parse(await readFile(active, 'utf8')).ownerToken, OWNER_B);
    assert.equal(JSON.parse(await readFile(active, 'utf8')).lockToken, LOCK_B);
  });
});

test('a detached exact retirement claim is consumed before a same-owner publication', async () => {
  await withRoot(async (root) => {
    const controls = join(root, '.kontour-physical-host-capacity', 'control-tickets');
    const active = await publishActiveControlLock(root, OWNER_C, LOCK_C);
    const candidate = join(controls, `.candidate-${OWNER_C}-${LOCK_C}.json`);
    const retired = join(controls, `.retired-${OWNER_C}.json`);
    await link(active, candidate);
    await link(active, retired);
    await unlink(active); // simulate a crash after unlink(active), before cleanup

    const lease = await acquireLease(config(root), { ownerToken: OWNER_C });
    assert.equal(lease.ownerToken, OWNER_C);
    assert.equal(existsSync(candidate), false);
    assert.equal(existsSync(retired), false);
    await releaseLease(config(root), OWNER_C);
  });
});

test('a stale same-owner cleanup cannot unlink a later foreign active lock', async () => {
  await withRoot(async (root) => {
    const raceConfig = config(root, { capacityUnits: 1, leaseWeight: 1, pollIntervalMs: 1 });
    await provisionHost(raceConfig);
    const controls = join(root, '.kontour-physical-host-capacity', 'control-tickets');
    await publishActiveControlLock(root, OWNER_C, LOCK_C);

    let clock = 0;
    let claimReached;
    const claimed = new Promise((resolve) => { claimReached = resolve; });
    let releaseClaim;
    const allowUnlink = new Promise((resolve) => { releaseClaim = resolve; });
    let unlinkReached;
    const unlinked = new Promise((resolve) => { unlinkReached = resolve; });
    let releaseRetire;
    const allowRetire = new Promise((resolve) => { releaseRetire = resolve; });

    const first = releaseLease(raceConfig, OWNER_C, {
      now: () => clock,
      sleep: async () => { clock += 6_000; },
      controlHooks: {
        async afterControlRetireClaim() {
          claimReached();
          await allowUnlink;
        },
        async afterControlRetire() {
          unlinkReached();
          await allowRetire;
        },
      },
    });
    await claimed;

    await assert.rejects(
      releaseLease(raceConfig, OWNER_C, {
        now: () => clock,
        sleep: async () => { clock += 6_000; },
      }),
      /same-owner control cleanup/,
    );

    releaseClaim();
    await unlinked;
    const foreignCandidate = join(controls, 'foreign-active.json');
    await writeFile(foreignCandidate, JSON.stringify(controlRecord(OWNER_A, LOCK_A)));
    await link(foreignCandidate, join(controls, 'active'));
    clock = 6_000;
    releaseRetire();

    await assert.rejects(first, /belongs to a different owner/);
    assert.equal(JSON.parse(await readFile(join(controls, 'active'), 'utf8')).ownerToken, OWNER_A);
  }, { provision: false });
});

test('control cleanup has bounded exact-path work despite foreign residue', async () => {
  await withRoot(async (root) => {
    const residueConfig = config(root, { capacityUnits: 1, leaseWeight: 1 });
    await provisionHost(residueConfig);
    const controls = join(root, '.kontour-physical-host-capacity', 'control-tickets');
    const foreign = join(controls, `.candidate-${OWNER_B}-${LOCK_B}.json`);
    await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(
      join(controls, `.candidate-99999999-9999-4999-8999-${String(index).padStart(12, '0')}-dddddddd-dddd-4ddd-8ddd-dddddddddddd.json`),
      JSON.stringify(controlRecord(OWNER_B, LOCK_B)),
    )));
    await writeFile(foreign, JSON.stringify(controlRecord(OWNER_B, LOCK_B)));

    assert.equal(await releaseLease(residueConfig, OWNER_C), false);
    assert.equal(existsSync(foreign), true);
  }, { provision: false });
});

test('contention diagnostics are capped and report omitted records', async () => {
  await withRoot(async (root) => {
    const diagnosticConfig = config(root, { capacityUnits: 8, leaseWeight: 1 });
    await provisionHost(diagnosticConfig);
    const leases = join(root, '.kontour-physical-host-capacity', 'leases');
    for (let index = 0; index < 8; index += 1) {
      const token = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      await writeFile(join(leases, `${token}.json`), JSON.stringify({ ownerToken: token, weight: 1, acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    }
    await assert.rejects(acquireLease(diagnosticConfig, { ownerToken: OWNER_A }), /leases=.*omitted=2/);
  }, { provision: false });
});

test('bounded contention diagnostics identify queue tickets without exposing unbounded metadata', async () => {
  await withRoot(async (root) => {
    const diagnosticConfig = config(root, { capacityUnits: 8, leaseWeight: 1 });
    await provisionHost(diagnosticConfig);
    const state = join(root, '.kontour-physical-host-capacity');
    const tickets = join(state, 'tickets');
    const overlongRunnerName = `desktop-win-linux-0-${'x'.repeat(200)}`;
    for (let index = 0; index < 8; index += 1) {
      const token = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const sequence = String(index + 1).padStart(20, '0');
      await mkdir(join(state, 'queue-sequences', sequence));
      await writeFile(join(tickets, `${token}.json`), JSON.stringify({
        ownerToken: token,
        weight: 1,
        sequence: index + 1,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        repository: `kontourai/ticket-${index}`,
        runId: String(30_770_000_000 + index),
        runAttempt: '1',
        workflow: 'CI Extended',
        job: 'playwright',
        runnerName: index === 0 ? overlongRunnerName : `desktop-win-linux-${index}`,
      }));
    }

    let diagnostic;
    await assert.rejects(
      acquireLease(diagnosticConfig, { ownerToken: OWNER_A }),
      (error) => {
        diagnostic = error;
        return error instanceof CapacityCoordinationError && /queue=.*omitted=3/.test(error.message);
      },
    );
    assert.match(diagnostic.message, /repo="kontourai\/ticket-0" run="30770000000"\/"1" workflow="CI Extended" job="playwright" runner="desktop-win-linux-0-/);
    assert.doesNotMatch(diagnostic.message, new RegExp('x'.repeat(121)));
    assert.doesNotMatch(diagnostic.message, /kontourai\/ticket-6/);
  }, { provision: false });
});

test('a partially published ticket fails closed and cannot be admitted', async () => {
  await withRoot(async (root) => {
    const tickets = join(root, '.kontour-physical-host-capacity', 'tickets');
    await writeFile(join(tickets, `${OWNER_A}.json`), '{"ownerToken":');
    await assert.rejects(acquireLease(config(root), { ownerToken: OWNER_B }), /Invalid queue ticket/);
  });
});

test('partial sequence, ticket, and lease records fail closed, then targeted recovery restores service', async () => {
  await withRoot(async (root) => {
    const state = join(root, '.kontour-physical-host-capacity');
    const sequences = join(state, 'queue-sequences');
    const tickets = join(state, 'tickets');
    const leases = join(state, 'leases');
    const marker = join(root, '.kontour-physical-host-quiesced');
    const args = (target) => ['--root', root, '--host-id', 'desktop-win-01', '--capacity-units', '3', '--owner-lifetime-seconds', '60', '--recover', target];

    await writeFile(join(sequences, '00000000000000000001'), 'partial');
    await assert.rejects(acquireLease(config(root), { ownerToken: OWNER_A }), /Invalid queue-sequence entry/);
    await writeFile(marker, 'desktop-win-01\n');
    await execFile(process.execPath, [recoverScript, ...args('sequence:00000000000000000001')]);
    await assert.rejects(access(join(sequences, '00000000000000000001')), { code: 'ENOENT' });

    const malformedTicket = join(tickets, `${OWNER_A}.json`);
    await writeFile(malformedTicket, '{"ownerToken":');
    await assert.rejects(acquireLease(config(root), { ownerToken: OWNER_B }), /Invalid queue ticket/);
    await writeFile(marker, 'desktop-win-01\n');
    await execFile(process.execPath, [recoverScript, ...args(`ticket:${OWNER_A}`)]);
    await assert.rejects(access(malformedTicket), { code: 'ENOENT' });

    const malformedLease = join(leases, `${OWNER_A}.json`);
    await writeFile(malformedLease, '{"ownerToken":');
    await assert.rejects(acquireLease(config(root), { ownerToken: OWNER_B }), /Invalid lease record/);
    await writeFile(marker, 'desktop-win-01\n');
    await execFile(process.execPath, [recoverScript, ...args(`lease:${OWNER_A}`)]);
    await assert.rejects(access(malformedLease), { code: 'ENOENT' });
    const acquired = await acquireLease(config(root), { ownerToken: OWNER_B });
    assert.equal(await releaseLease(config(root), acquired.ownerToken), true);
  });
});

test('host manifest rejects participants with conflicting capacity semantics', async () => {
  await withRoot(async (root) => {
    await acquireLease(config(root), { ownerToken: OWNER_A });

    await assert.rejects(
      acquireLease(config(root, { capacityUnits: 4 }), { ownerToken: OWNER_B }),
      /Host manifest mismatch.*capacityUnits/,
    );
    await assert.rejects(
      acquireLease(config(root, { hostId: 'desktop-win-02' }), { ownerToken: OWNER_B }),
      /External host marker mismatch/,
    );
  });
});

test('a malformed host manifest fails closed before capacity can be acquired', async () => {
  await withRoot(async (root) => {
    const state = join(root, '.kontour-physical-host-capacity');
    await mkdir(state, { recursive: true });
    await writeFile(join(state, 'host-manifest.json'), '{not-json');

    await assert.rejects(
      acquireLease(config(root), { ownerToken: OWNER_A }),
      /Invalid host manifest/,
    );
  });
});

test('an uninitialized root cannot be silently adopted', async () => {
  await withRoot(async (root) => {
    const leases = join(root, '.kontour-physical-host-capacity', 'leases');
    await mkdir(leases, { recursive: true });
    await writeFile(join(leases, `${OWNER_A}.json`), JSON.stringify({ ownerToken: OWNER_A, weight: 1, acquiredAt: new Date().toISOString() }));

    await assert.rejects(
      acquireLease(config(root), { ownerToken: OWNER_B }),
      /External host marker is required/,
    );
  }, { provision: false });
});

test('provisioning rejects a symlinked state path without writing through it', async () => {
  await withRoot(async (root) => {
    const state = join(root, '.kontour-physical-host-capacity');
    const outside = join(root, 'outside-target');
    await mkdir(outside);
    await symlink(outside, state);
    await assert.rejects(provisionHost(config(root)), /coordination state directory.*real directory, not a symlink or junction/);
    assert.deepEqual(await readdir(outside), []);
  }, { provision: false });
});

test('a symlinked root marker is rejected before coordination reads it', async () => {
  await withRoot(async (root) => {
    const marker = join(root, '.kontour-physical-host-id');
    const replacement = join(root, 'replacement-marker');
    await writeFile(replacement, 'desktop-win-01\n');
    await rm(marker);
    await symlink(replacement, marker);
    await assert.rejects(acquireLease(config(root), { ownerToken: OWNER_A }), /regular file, not a symlink or junction/);
  });
});

test('a symlinked coordination state directory is rejected before reads or deletes', async () => {
  await withRoot(async (root) => {
    const state = join(root, '.kontour-physical-host-capacity');
    const replacement = join(root, 'replacement-state');
    await mkdir(replacement);
    await rm(state, { recursive: true, force: true });
    await symlink(replacement, state);
    await assert.rejects(acquireLease(config(root), { ownerToken: OWNER_A }), /real directory, not a symlink or junction/);
  });
});

test('symlinked manifest and lease records are rejected without being followed', async () => {
  await withRoot(async (root) => {
    const state = join(root, '.kontour-physical-host-capacity');
    const manifest = join(state, 'host-manifest.json');
    const manifestReplacement = join(root, 'manifest-replacement');
    await writeFile(manifestReplacement, await readFile(manifest, 'utf8'));
    await rm(manifest);
    await symlink(manifestReplacement, manifest);
    await assert.rejects(acquireLease(config(root), { ownerToken: OWNER_A }), /host manifest.*regular file, not a symlink or junction/);
  });
  await withRoot(async (root) => {
    const leases = join(root, '.kontour-physical-host-capacity', 'leases');
    const replacement = join(root, 'lease-replacement');
    await writeFile(replacement, JSON.stringify({ ownerToken: OWNER_A, weight: 1, acquiredAt: '2020-01-01T00:00:00.000Z' }));
    await symlink(replacement, join(leases, `${OWNER_A}.json`));
    await assert.rejects(acquireLease(config(root), { ownerToken: OWNER_B }), /Unexpected lease record/);
  });
});

test('metadata cannot override a lease owner, weight, or acquisition time', async () => {
  await withRoot(async (root) => {
    const acquired = await acquireLease(config(root), {
      ownerToken: OWNER_A,
      metadata: { ownerToken: OWNER_B, weight: 99, acquiredAt: '2020-01-01T00:00:00.000Z', repository: 'example' },
    });
    const lease = JSON.parse(await readFile(acquired.leasePath, 'utf8'));
    assert.equal(lease.ownerToken, OWNER_A);
    assert.equal(lease.weight, 2);
    assert.notEqual(lease.acquiredAt, '2020-01-01T00:00:00.000Z');
    assert.equal(lease.repository, 'example');
  });
});

test('ticket metadata is observable and cannot override FIFO ownership fields', async () => {
  await withRoot(async (root) => {
    const waitingConfig = config(root, { capacityUnits: 1, leaseWeight: 1, timeoutMs: 5_000, pollIntervalMs: 2 });
    await provisionHost(waitingConfig);
    await acquireLease(waitingConfig, { ownerToken: OWNER_A });
    const ticketPath = join(root, '.kontour-physical-host-capacity', 'tickets', `${OWNER_B}.json`);
    const waiting = acquireLease(waitingConfig, {
      ownerToken: OWNER_B,
      metadata: {
        ownerToken: OWNER_C,
        weight: 99,
        sequence: 99,
        acquiredAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-01T00:01:00.000Z',
        repository: 'kontourai/station',
        runId: '30770000000',
        runAttempt: '2',
        workflow: 'CI Extended',
        job: 'playwright',
        runnerName: 'desktop-win-linux',
      },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(ticketPath);
        break;
      } catch {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 2));
      }
    }
    const ticket = JSON.parse(await readFile(ticketPath, 'utf8'));
    assert.equal(ticket.ownerToken, OWNER_B);
    assert.equal(ticket.weight, 1);
    assert.equal(ticket.sequence, 2);
    assert.notEqual(ticket.acquiredAt, '2020-01-01T00:00:00.000Z');
    assert.notEqual(ticket.expiresAt, '2020-01-01T00:01:00.000Z');
    assert.deepEqual(
      {
        repository: ticket.repository,
        runId: ticket.runId,
        runAttempt: ticket.runAttempt,
        workflow: ticket.workflow,
        job: ticket.job,
        runnerName: ticket.runnerName,
      },
      {
        repository: 'kontourai/station',
        runId: '30770000000',
        runAttempt: '2',
        workflow: 'CI Extended',
        job: 'playwright',
        runnerName: 'desktop-win-linux',
      },
    );
    await releaseLease(waitingConfig, OWNER_A);
    const acquired = await waiting;
    await releaseLease(waitingConfig, acquired.ownerToken);
  }, { provision: false });
});

test('legacy tickets without metadata remain valid and use safe diagnostic fallbacks', async () => {
  await withRoot(async (root) => {
    const legacyTicketConfig = config(root, { capacityUnits: 1, leaseWeight: 1 });
    await provisionHost(legacyTicketConfig);
    const state = join(root, '.kontour-physical-host-capacity');
    await mkdir(join(state, 'queue-sequences', '00000000000000000001'));
    await writeFile(
      join(state, 'tickets', `${OWNER_A}.json`),
      JSON.stringify({
        ownerToken: OWNER_A,
        weight: 1,
        sequence: 1,
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    await assert.rejects(
      acquireLease(legacyTicketConfig, { ownerToken: OWNER_B }),
      (error) => error instanceof CapacityCoordinationError
        && /queue=11111111 weight=1 sequence=1 repo="unknown" run="unknown"\/"unknown" workflow="unknown" job="unknown" runner="unknown"/.test(error.message),
    );
  }, { provision: false });
});

test('action entrypoints persist state and release the acquired lease in the post step', async () => {
  await withRoot(async (root) => {
    await provisionHost(config(root, { capacityUnits: 1 }));
    const output = join(root, 'output');
    const environment = join(root, 'environment');
    const state = join(root, 'state');
    await Promise.all([writeFile(output, ''), writeFile(environment, ''), writeFile(state, '')]);
    const actionEnv = {
      ...process.env,
      INPUT_COORDINATION_ROOT: root,
      INPUT_HOST_ID: 'desktop-win-01',
      INPUT_CAPACITY_UNITS: '1',
      INPUT_LEASE_WEIGHT: '1',
      INPUT_TIMEOUT_SECONDS: '0',
      INPUT_POLL_INTERVAL_MS: '1',
      INPUT_OWNER_LIFETIME_SECONDS: '60',
      GITHUB_OUTPUT: output,
      GITHUB_ENV: environment,
      GITHUB_STATE: state,
      GITHUB_REPOSITORY: 'kontourai/example',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '3',
      GITHUB_WORKFLOW: 'Capacity contract',
      GITHUB_WORKFLOW_REF:
        'kontourai/example/.github/workflows/capacity.yml@refs/heads/test',
      GITHUB_JOB: 'test',
      RUNNER_NAME: 'fixture-linux',
      RUNNER_OS: 'Linux',
    };
    await execFile(process.execPath, [acquireScript], { env: actionEnv });
    const outputs = Object.fromEntries((await readFile(output, 'utf8')).trim().split('\n').map((line) => line.split('=')));
    await access(outputs['lease-path']);
    const lease = JSON.parse(await readFile(outputs['lease-path'], 'utf8'));
    assert.deepEqual(
      {
        repository: lease.repository,
        runId: lease.runId,
        runAttempt: lease.runAttempt,
        workflow: lease.workflow,
        workflowRef: lease.workflowRef,
        job: lease.job,
        runnerName: lease.runnerName,
        runnerOs: lease.runnerOs,
      },
      {
        repository: 'kontourai/example',
        runId: '42',
        runAttempt: '3',
        workflow: 'Capacity contract',
        workflowRef:
          'kontourai/example/.github/workflows/capacity.yml@refs/heads/test',
        job: 'test',
        runnerName: 'fixture-linux',
        runnerOs: 'Linux',
      },
    );

    const postState = Object.fromEntries((await readFile(state, 'utf8')).trim().split('\n').map((line) => {
      const [name, ...value] = line.split('=');
      return [`STATE_${name}`, value.join('=')];
    }));
    await execFile(process.execPath, [releaseScript], {
      env: {
        ...actionEnv,
        ...postState,
        'INPUT_COORDINATION-ROOT': '/poisoned-canonical-after-acquire',
        INPUT_COORDINATION_ROOT: '/poisoned-portable-after-acquire',
        'INPUT_HOST-ID': 'poisoned-canonical-after-acquire',
        INPUT_HOST_ID: 'poisoned-portable-after-acquire',
      },
    });
    await assert.rejects(access(outputs['lease-path']), { code: 'ENOENT' });
  }, { provision: false });
});

test('main action directly releases its lease when output and state command files disappear after acquisition', async () => {
  await withRoot(async (root) => {
    await provisionHost(config(root, { capacityUnits: 1 }));
    const output = join(root, 'output');
    const environment = join(root, 'environment');
    const state = join(root, 'state');
    await Promise.all([writeFile(output, ''), writeFile(environment, ''), writeFile(state, '')]);
    const actionEnv = {
      INPUT_COORDINATION_ROOT: root,
      INPUT_HOST_ID: 'desktop-win-01',
      INPUT_CAPACITY_UNITS: '1',
      INPUT_LEASE_WEIGHT: '1',
      INPUT_TIMEOUT_SECONDS: '0',
      INPUT_POLL_INTERVAL_MS: '1',
      INPUT_OWNER_LIFETIME_SECONDS: '60',
      GITHUB_OUTPUT: output,
      GITHUB_ENV: environment,
      GITHUB_STATE: state,
      GITHUB_REPOSITORY: 'kontourai/example',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '3',
      GITHUB_WORKFLOW: 'CI Extended',
      GITHUB_WORKFLOW_REF: 'kontourai/example/.github/workflows/ci.yml@refs/heads/main',
      GITHUB_JOB: 'playwright',
      RUNNER_NAME: 'desktop-win-linux',
      RUNNER_OS: 'Linux',
    };

    await assert.rejects(
      runAcquireAction({
        env: actionEnv,
        ownerToken: OWNER_A,
        writeOne: async (file, name, value) => {
          if (file === output) {
            // Simulate Actions removing its command-file directory after the
            // lease has been published. The post step cannot read STATE_*.
            await Promise.all([rm(output), rm(state)]);
          }
          await appendFile(file, `${name}=${value}\n`, 'utf8');
        },
        writeMany: async (file, values) => {
          await appendFile(file, `${values.map(([name, value]) => `${name}=${value}`).join('\n')}\n`, 'utf8');
        },
      }),
      (error) => error instanceof CapacityCoordinationError && /ENOENT/.test(error.message) && /Direct cleanup released the owned lease/.test(error.message),
    );

    const stateDirectory = join(root, '.kontour-physical-host-capacity');
    assert.deepEqual(await readdir(join(stateDirectory, 'leases')), []);
    assert.deepEqual(await readdir(join(stateDirectory, 'tickets')), []);
    const post = await execFile(process.execPath, [releaseScript], { env: actionEnv });
    assert.match(post.stdout, /no acquired lease to release/);
  }, { provision: false });
});

test('a release waits out control-ticket contention instead of leaking its lease', async () => {
  // The leak this prevents: releaseLease used a fixed ~5s control budget while
  // acquireLease used the caller's full timeout, so a release that lost the
  // race gave up and left its lease behind forever. Nothing reclaims a lease
  // automatically, so the host permanently lost that weight — and the reduced
  // capacity made the next release more likely to lose the same race.
  //
  // The clock is injected so the contention outlasts the OLD fixed budget in
  // virtual time: with that budget this rejects and the lease survives, which
  // is what makes this test discriminate rather than merely pass.
  await withRoot(async (root) => {
    const base = config(root, { timeoutMs: 600_000, pollIntervalMs: 1_000 });
    const lease = await acquireLease(base, { ownerToken: OWNER_A });
    assert.equal(lease.ownerToken, OWNER_A);

    const controls = join(root, '.kontour-physical-host-capacity', 'control-tickets');
    const active = join(controls, 'active');
    const squatter = join(root, 'squatter-control.json');
    await writeFile(squatter, JSON.stringify({
      ownerToken: OWNER_B,
      lockToken: LOCK_B,
      repository: 'kontourai/station',
      runId: '1',
      runAttempt: '1',
      workflow: 'CI',
      job: 'fast-checks',
      runnerName: 'desktop-win-linux-2',
    }));
    await link(squatter, active);

    // A concurrent holder that finishes after 30 virtual seconds — well beyond
    // the old 5s release budget, well inside the acquire timeout.
    const HOLD_MS = 30_000;
    let clock = 0;
    let handedOver = false;
    const now = () => clock;
    const sleep = async (ms) => {
      clock += ms;
      if (!handedOver && clock >= HOLD_MS) {
        handedOver = true;
        await unlink(active);
      }
    };

    const released = await releaseLease(base, OWNER_A, { now, sleep });
    assert.equal(handedOver, true, 'the release should have waited for the holder to finish');
    assert.equal(released, true);
    assert.deepEqual(
      await readdir(join(root, '.kontour-physical-host-capacity', 'leases')),
      [],
      'the lease must not survive its release',
    );
  });
});
