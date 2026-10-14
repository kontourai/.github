import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkRepository, classifySpec, loadVersionSet, validateVersionSet } from './version-set-drift.mjs';
import { main as refreshMain, refreshVersionSet } from './version-set-refresh.mjs';

const DRIFT = fileURLToPath(new URL('./version-set-drift.mjs', import.meta.url));
const REFRESH = fileURLToPath(new URL('./version-set-refresh.mjs', import.meta.url));

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'version-set-drift-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function set(packages, previous = null, train = '2026.10-a') {
  return { schemaVersion: 1, train, date: '2026-10-14', packages, previous, consumers: ['kontourai/consumer'] };
}

function drift(args) {
  return spawnSync(process.execPath, [DRIFT, ...args], { encoding: 'utf8' });
}

test('classification: current, ahead, behind with headroom, stale below the previous train', () => {
  assert.equal(classifySpec('^6.0.0', '6.1.0', '5.4.0'), 'current');
  assert.equal(classifySpec('^5.0.0 || ^6.0.0', '6.1.0', '5.4.0'), 'current');
  assert.equal(classifySpec('7.0.0', '6.1.0', '5.4.0'), 'ahead');
  // Missing the set but admitting the previous train is the headroom.
  assert.equal(classifySpec('^5.0.0', '6.1.0', '5.4.0'), 'behind');
  assert.equal(classifySpec('5.4.0', '6.1.0', '5.4.0'), 'behind');
  // Between the trains is not below the previous train.
  assert.equal(classifySpec('6.0.0', '6.1.0', '5.4.0'), 'behind');
  // No previous train for the package means no floor yet.
  assert.equal(classifySpec('^1.0.0', '6.1.0', undefined), 'behind');
  assert.equal(classifySpec('^4.0.0', '6.1.0', '5.4.0'), 'stale');
  assert.equal(classifySpec('5.3.9', '6.1.0', '5.4.0'), 'stale');
  // 0.x minors are breaking, and semver ranges already say so.
  assert.equal(classifySpec('^0.6.0', '0.7.1', '0.7.0'), 'stale');
  assert.equal(classifySpec('latest', '6.1.0', '5.4.0'), 'unrecognized');
});

test('the set refuses malformed trains, versions and consumers', () => {
  const good = set({ '@kontourai/surface': '6.1.0' });
  assert.doesNotThrow(() => validateVersionSet(structuredClone(good)));
  const bad = [
    { ...good, schemaVersion: 2 },
    { ...good, packages: { '@kontourai/surface': '^6.1.0' } },
    { ...good, packages: { '@kontourai/surface': '6.2.0-rc.1' } },
    { ...good, packages: { 'surface': '6.1.0' } },
    { ...good, previous: { train: '2026.10-a', packages: {} } },
    { ...good, previous: { train: '2026.09-a', packages: {}, extra: true } },
    { ...good, consumers: ['other/repo'] },
    { ...good, consumers: ['kontourai/a', 'kontourai/a'] },
    { ...good, date: '14 Oct' },
    { ...good, surprise: 1 },
  ];
  for (const candidate of bad) assert.throws(() => validateVersionSet(candidate), undefined, JSON.stringify(candidate));
});

test('the committed version set is valid and starts with no previous train', () => {
  const committed = loadVersionSet();
  assert.equal(committed.previous, null);
  assert.ok(Object.keys(committed.packages).length > 0);
});

test('scans the root and published workspaces, skipping private and intra-repo packages', (t) => {
  const root = scratch(t);
  writeJson(join(root, 'package.json'), {
    name: '@kontourai/consumer', private: true, workspaces: ['packages/*', '!packages/ignored'],
    dependencies: { '@kontourai/surface': '3.2.0', '@kontourai/lib': '^1.0.0', 'left-pad': '1.0.0' },
    devDependencies: { '@kontourai/flow': 'workspace:*', '@kontourai/unknown': '1.0.0' },
  });
  writeJson(join(root, 'packages/lib/package.json'), {
    name: '@kontourai/lib', peerDependencies: { '@kontourai/surface': '^6.0.0' },
  });
  writeJson(join(root, 'packages/example/package.json'), {
    name: '@kontourai/example', private: true, dependencies: { '@kontourai/surface': '1.0.0' },
  });
  writeJson(join(root, 'packages/ignored/package.json'), {
    name: '@kontourai/ignored', dependencies: { '@kontourai/surface': '1.0.0' },
  });
  const findings = checkRepository(root, set({ '@kontourai/surface': '6.1.0', '@kontourai/flow': '5.2.1' }), 'consumer');
  assert.deepEqual(findings.map((f) => [f.manifest, f.section, f.package, f.status]), [
    ['package.json', 'dependencies', '@kontourai/surface', 'behind'],
    ['package.json', 'devDependencies', '@kontourai/unknown', 'untracked'],
    ['packages/lib/package.json', 'peerDependencies', '@kontourai/surface', 'current'],
  ]);
});

test('reads pnpm-workspace.yaml packages, including negations', (t) => {
  const root = scratch(t);
  writeJson(join(root, 'package.json'), { name: 'root', private: true });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - "!packages/skip"\n');
  writeJson(join(root, 'packages/a/package.json'), { name: 'a', dependencies: { '@kontourai/ui': '1.20.1' } });
  writeJson(join(root, 'packages/skip/package.json'), { name: 'skip', dependencies: { '@kontourai/ui': '1.0.0' } });
  const findings = checkRepository(root, set({ '@kontourai/ui': '1.20.1' }));
  assert.deepEqual(findings.map((f) => [f.manifest, f.status]), [['packages/a/package.json', 'current']]);
});

// The drift exit, run as a child process the way the reusable workflow runs it.
// The headroom invariant: a consumer current at train N passes --fail-on stale
// at train N+1 and fails only at N+2 if it still has not moved.
test('advancing the train never fails a consumer that was current on the previous train', (t) => {
  const dir = scratch(t);
  const consumer = join(dir, 'consumer');
  writeJson(join(consumer, 'package.json'), { name: 'consumer', dependencies: { '@kontourai/surface': '6.1.0' } });
  const setPath = join(dir, 'version-set.json');
  const latest = { '@kontourai/surface': '6.1.0' };
  const refresh = (train) => assert.equal(refreshMain(['--set', setPath, '--train', train, '--date', '2026-10-14'], {
    latest: (name) => latest[name], stdout: { write() {} }, stderr: { write(m) { throw new Error(m); } },
  }), 0);

  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }, null, '2026.10-a'));
  let run = drift(['--set', setPath, '--fail-on', 'stale', '--json', consumer]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).results[0].findings[0].status, 'current');

  latest['@kontourai/surface'] = '7.0.0';
  refresh('2026.10-b');
  run = drift(['--set', setPath, '--fail-on', 'stale', '--json', consumer]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(JSON.parse(run.stdout).results[0].findings[0].status, 'behind');
  // The audit mode is stricter: missing the current train is drift.
  run = drift(['--set', setPath, '--fail-on', 'drift', consumer]);
  assert.equal(run.status, 1, run.stdout + run.stderr);

  latest['@kontourai/surface'] = '8.0.0';
  refresh('2026.11-a');
  run = drift(['--set', setPath, '--fail-on', 'stale', consumer]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /STALE\s+package\.json dependencies @kontourai\/surface 6\.1\.0 \(set 8\.0\.0, previous 7\.0\.0\)/u);

  // By default the same drift is reported and the job still succeeds.
  run = drift(['--set', setPath, consumer]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /STALE/u);
  assert.match(run.stdout, /Advisory: drift is reported, not enforced\./u);
});

test('--fail-on drift passes a consumer on the train, ignoring packages outside the set', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }));
  const consumer = join(dir, 'consumer');
  writeJson(join(consumer, 'package.json'), {
    name: 'consumer', dependencies: { '@kontourai/surface': '^6.0.0', '@kontourai/not-in-set': '0.1.0' },
  });
  let run = drift(['--set', setPath, '--fail-on', 'drift', consumer]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /UNTRACKED\s+package\.json dependencies @kontourai\/not-in-set 0\.1\.0 \(not in the set\)/u);
  run = drift(['--set', setPath, '--fail-on', 'everything', consumer]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--fail-on must be one of none, stale, drift/u);
});

test('unreadable inputs fail with exit 2 instead of reporting success', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }));
  const consumer = join(dir, 'consumer');
  mkdirSync(consumer);

  let run = drift(['--set', setPath, consumer]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no package\.json/u);

  writeFileSync(join(consumer, 'package.json'), '{ not json');
  run = drift(['--set', setPath, consumer]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /package\.json/u);

  writeJson(join(consumer, 'package.json'), { name: 'consumer' });
  writeFileSync(setPath, '{"schemaVersion": 1}');
  run = drift(['--set', setPath, consumer]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /train/u);

  run = drift(['--set', setPath]);
  assert.equal(run.status, 2);
  run = drift(['--set', setPath, '--bogus', consumer]);
  assert.equal(run.status, 2);
});

test('writes a markdown summary when asked', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }));
  const consumer = join(dir, 'consumer');
  writeJson(join(consumer, 'package.json'), { name: 'consumer', dependencies: { '@kontourai/surface': '^3.0.0 || ^4.0.0' } });
  const summary = join(dir, 'summary.md');
  const run = drift(['--set', setPath, '--markdown-summary', summary, '--label', 'kontourai/consumer', consumer]);
  assert.equal(run.status, 0, run.stderr);
  const text = readFileSync(summary, 'utf8');
  assert.match(text, /\*\*kontourai\/consumer\*\*: 0 current, 1 behind/u);
  assert.match(text, /`\^3\.0\.0 \\\|\\\| \^4\.0\.0`/u);
});

test('--all clones each listed consumer and checks its manifests', (t) => {
  const dir = scratch(t);
  const source = join(dir, 'src');
  writeJson(join(source, 'package.json'), { name: 'consumer', private: true, workspaces: ['pkg'] });
  writeJson(join(source, 'pkg/package.json'), { name: 'pkg', dependencies: { '@kontourai/surface': '5.0.0' } });
  writeFileSync(join(source, 'pkg/index.js'), 'export {};\n');
  const git = (...args) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'init');
  execFileSync('git', ['clone', '--quiet', '--bare', source, join(dir, 'remote/kontourai/consumer.git')], { stdio: 'pipe' });
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }, { train: '2026.09-a', packages: { '@kontourai/surface': '5.0.0' } }));

  const gitBase = `${pathToFileURL(join(dir, 'remote')).href}/`;
  let run = drift(['--set', setPath, '--all', '--git-base', gitBase, '--json']);
  assert.equal(run.status, 0, run.stderr);
  const [result] = JSON.parse(run.stdout).results;
  assert.equal(result.repository, 'kontourai/consumer');
  assert.deepEqual(result.findings.map((f) => [f.manifest, f.status]), [['pkg/package.json', 'behind']]);

  rmSync(join(dir, 'remote'), { recursive: true });
  run = drift(['--set', setPath, '--all', '--git-base', gitBase]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /kontourai\/consumer: clone failed/u);
});

test('refresh takes npm latest for the listed packages and refuses to move backwards', () => {
  const current = set({ '@kontourai/surface': '6.1.0', '@kontourai/flow': '5.2.1' });
  const next = refreshVersionSet(current, {
    train: '2026.10-b', date: '2026-10-20', add: ['@kontourai/ui'],
    latest: (name) => ({ '@kontourai/surface': '7.0.0', '@kontourai/flow': '5.2.1', '@kontourai/ui': '1.20.1' })[name],
  });
  assert.deepEqual(next.packages, { '@kontourai/flow': '5.2.1', '@kontourai/surface': '7.0.0', '@kontourai/ui': '1.20.1' });
  assert.deepEqual(next.previous, { train: '2026.10-a', packages: current.packages });
  assert.deepEqual(next.consumers, current.consumers);

  assert.throws(() => refreshVersionSet(current, { train: '2026.10-b', date: '2026-10-20', latest: () => '6.0.0' }), /older than the set's 6\.1\.0/u);
  assert.throws(() => refreshVersionSet(current, { train: '2026.10-a', date: '2026-10-20', latest: () => '7.0.0' }), /already the current train/u);
});

test('refresh refuses a prerelease npm latest and leaves the set unchanged', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }));
  const stub = join(dir, 'npm');
  writeFileSync(stub, '#!/bin/sh\necho \'{"latest":"7.0.0-rc.1"}\'\n', { mode: 0o755 });
  const run = spawnSync(process.execPath, [REFRESH, '--set', setPath, '--train', '2026.10-b'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  assert.equal(run.status, 2, run.stdout);
  assert.match(run.stderr, /not a stable version/u);
  assert.equal(JSON.parse(readFileSync(setPath, 'utf8')).train, '2026.10-a');
});
