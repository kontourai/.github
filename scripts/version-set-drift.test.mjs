import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkRepository, classifySpec, compatibilityFloor, isolatedGitEnvironment, loadVersionSet, validateVersionSet } from './version-set-drift.mjs';
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

function drift(args, env = process.env) {
  return spawnSync(process.execPath, [DRIFT, ...args], { encoding: 'utf8', env });
}

test('the compatibility floor is the major, or the minor for 0.x', () => {
  assert.equal(compatibilityFloor('6.1.2'), '6.0.0');
  assert.equal(compatibilityFloor('0.7.1'), '0.7.0');
  assert.equal(compatibilityFloor('0.0.3'), '0.0.3');
});

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
  // Below the previous train's version but within its major is headroom too.
  assert.equal(classifySpec('5.0.0', '6.1.0', '5.4.0'), 'behind');
  // Stale means a breaking release behind the previous train (pin literal: 5.0.0).
  assert.equal(classifySpec('^4.0.0', '6.1.0', '5.4.0'), 'stale');
  assert.equal(classifySpec('4.9.9', '6.1.0', '5.4.0'), 'stale');
  // 0.x minors are breaking (floor 0.7.0 for previous 0.7.3).
  assert.equal(classifySpec('0.7.0', '0.8.0', '0.7.3'), 'behind');
  assert.equal(classifySpec('^0.6.0', '0.8.0', '0.7.3'), 'stale');
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
    { ...good, consumers: ['other/repo'] },
    { ...good, consumers: ['kontourai/a', 'kontourai/a'] },
    { ...good, date: '14 Oct' },
  ];
  for (const candidate of bad) assert.throws(() => validateVersionSet(candidate), undefined, JSON.stringify(candidate));
});

// A pinned older script must keep reading a set that gained an additive field;
// only a schemaVersion bump may make it refuse the file.
test('the set ignores fields it does not know', () => {
  const good = set({ '@kontourai/surface': '6.1.0' }, { train: '2026.09-a', packages: {}, note: 'x' });
  assert.doesNotThrow(() => validateVersionSet({ ...good, matrix: { nightly: false } }));
  const carried = refreshVersionSet({ ...good, matrix: { nightly: false } }, {
    train: '2026.10-b', date: '2026-10-20', latest: () => '6.1.1',
  });
  assert.deepEqual(carried.matrix, { nightly: false });
});

// Deliberately asserts nothing about the train or previous: advancing the set
// must not need a test edit.
test('the committed version set is valid', () => {
  const committed = loadVersionSet();
  assert.ok(Object.keys(committed.packages).length > 0);
  assert.ok(committed.consumers.length > 0);
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

// Station and Console pin exact versions. Patch- and minor-only trains must not
// stale such a pin; it goes stale only once a breaking release has moved past
// it and a further train has elapsed.
function trainSequence(t, pin, steps) {
  const dir = scratch(t);
  const consumer = join(dir, 'consumer');
  writeJson(join(consumer, 'package.json'), { name: 'consumer', dependencies: { '@kontourai/pkg': pin } });
  const setPath = join(dir, 'version-set.json');
  const [first, ...rest] = steps;
  writeJson(setPath, set({ '@kontourai/pkg': first }, null, 'train-0'));
  const statuses = [];
  const record = () => {
    const run = drift(['--set', setPath, '--fail-on', 'stale', '--json', consumer]);
    assert.notEqual(run.status, 2, run.stderr);
    statuses.push([JSON.parse(run.stdout).results[0].findings[0].status, run.status]);
  };
  record();
  rest.forEach((version, index) => {
    assert.equal(refreshMain(['--set', setPath, '--train', `train-${index + 1}`, '--date', '2026-10-14'], {
      latest: () => version, stdout: { write() {} }, stderr: { write(m) { throw new Error(m); } },
    }), 0);
    record();
  });
  return statuses;
}

test('an exact pin survives patch trains and goes stale a train after a major passes it', (t) => {
  assert.deepEqual(trainSequence(t, '6.1.0', ['6.1.0', '6.1.1', '6.1.2', '6.2.0', '7.0.0', '7.0.1']), [
    ['current', 0], ['behind', 0], ['behind', 0], ['behind', 0], ['behind', 0], ['stale', 1],
  ]);
});

test('a 0.x exact pin survives patch trains and goes stale a train after a minor passes it', (t) => {
  assert.deepEqual(trainSequence(t, '0.7.0', ['0.7.0', '0.7.1', '0.7.2', '0.8.0', '0.8.1']), [
    ['current', 0], ['behind', 0], ['behind', 0], ['behind', 0], ['stale', 1],
  ]);
});

test('a 0.0.x exact pin goes stale a train after a patch passes it', (t) => {
  assert.deepEqual(trainSequence(t, '0.0.3', ['0.0.3', '0.0.4', '0.0.5']), [
    ['current', 0], ['behind', 0], ['stale', 1],
  ]);
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

  // Node's JSON.parse message quotes input like this ("Unexpected token 'S', \"SECRET...").
  writeFileSync(join(consumer, 'package.json'), 'SECRET-CONTENT');
  run = drift(['--set', setPath, consumer]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /package\.json: not valid JSON/u);
  assert.doesNotMatch(run.stderr, /SECRET/u);

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

test('reads stay inside the checkout and parse errors echo no content', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }));
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'TOPSECRET-VALUE\n');
  const outside = join(dir, 'outside');
  writeJson(join(outside, 'package.json'), { name: 'outside', dependencies: { '@kontourai/surface': '1.0.0' } });
  const fresh = (name, workspaces) => {
    const root = join(dir, name);
    writeJson(join(root, 'package.json'), { name, private: true, workspaces });
    return root;
  };
  const expectRefusal = (root, pattern) => {
    const run = drift(['--set', setPath, root]);
    assert.equal(run.status, 2, run.stdout);
    assert.match(run.stderr, pattern);
    assert.doesNotMatch(run.stderr + run.stdout, /TOPSECRET/u);
  };

  let root = fresh('file-link', ['packages/*']);
  mkdirSync(join(root, 'packages/a'), { recursive: true });
  symlinkSync(secret, join(root, 'packages/a/package.json'));
  expectRefusal(root, /packages\/a\/package\.json: is a symlink/u);

  root = fresh('dir-link', ['packages/*']);
  mkdirSync(join(root, 'packages'));
  symlinkSync(outside, join(root, 'packages/a'));
  expectRefusal(root, /packages\/a: resolves outside the checkout/u);

  root = fresh('dotdot', ['../outside']);
  expectRefusal(root, /workspace pattern "\.\.\/outside" leaves the checkout/u);

  root = fresh('negated-dotdot', ['!../outside']);
  expectRefusal(root, /leaves the checkout/u);

  root = join(dir, 'root-link');
  mkdirSync(root);
  symlinkSync(secret, join(root, 'package.json'));
  expectRefusal(root, /package\.json: is a symlink/u);

  root = fresh('yaml', undefined);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: [TOPSECRET-VALUE\n');
  expectRefusal(root, /pnpm-workspace\.yaml: not valid YAML/u);
});

test('invalid @kontourai package names are refused', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }));
  const consumer = join(dir, 'consumer');
  writeJson(join(consumer, 'package.json'), { name: 'consumer', dependencies: { '@kontourai/x|`y`': '1.0.0' } });
  const run = drift(['--set', setPath, consumer]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /names an invalid package/u);
});

// No line of output may start a workflow command, whatever a manifest, a
// directory name or a label contains.
function assertNoWorkflowCommand(...outputs) {
  for (const output of outputs) assert.doesNotMatch(output, /^\s*::/mu, output);
}

test('manifest text cannot inject Markdown or workflow commands', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }));
  const consumer = join(dir, 'consumer');
  writeJson(join(consumer, 'package.json'), {
    name: 'consumer',
    dependencies: {
      '@kontourai/surface': '1.0.0 | `x`',
      '@kontourai/ui': '\n::error::injected',
      '@kontourai/flow': 'https://evil.example www.evil.example $x^2$ \u202edlrow',
    },
  });
  const summary = join(dir, 'summary.md');
  const run = drift(['--set', setPath, '--markdown-summary', summary, '--label', 'x\n::error::label', consumer]);
  assert.equal(run.status, 0, run.stderr);
  assertNoWorkflowCommand(run.stdout, run.stderr);
  assert.match(run.stdout, /"\\u000a::error::injected"/u);
  assert.match(run.stdout, /^Repository "x\\u000a::error::label": 3 @kontourai specs/mu);
  const text = readFileSync(summary, 'utf8');
  assertNoWorkflowCommand(text);
  // Manifest text renders as code spans: no autolink, math, emphasis or bidi.
  assert.match(text, /\| `` 1\.0\.0 \\\| `x` `` \|/u);
  assert.match(text, /\| `"https:\/\/evil\.example www\.evil\.example \$x\^2\$ \\u202edlrow"` \|/u);
  assert.doesNotMatch(text, /\u202e/u);
});

test('a directory name cannot inject a workflow command into an error', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }));
  const consumer = join(dir, 'consumer');
  writeJson(join(consumer, 'package.json'), { name: 'consumer', private: true, workspaces: ['packages/*'] });
  const evil = join(consumer, 'packages', 'x\n::error title=spoof::injected');
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(dir, 'target.json'), '{}');
  symlinkSync(join(dir, 'target.json'), join(evil, 'package.json'));
  let run = drift(['--set', setPath, consumer]);
  assert.equal(run.status, 2, run.stdout);
  assert.match(run.stderr, /\\u000a::error title=spoof::injected\/package\.json"?: is a symlink/u);
  assertNoWorkflowCommand(run.stdout, run.stderr);

  // The checkout path itself, in the no-package.json error.
  const bare = join(dir, 'y\n::error::bare');
  mkdirSync(bare);
  run = drift(['--set', setPath, bare]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no package\.json/u);
  assertNoWorkflowCommand(run.stdout, run.stderr);
});

// Two layers keep errors printable: each value is quoted where the message is
// built, and main escapes the whole line it writes. These tests reach each
// layer on its own.
test('input errors quote paths where they are raised', (t) => {
  const root = scratch(t);
  writeJson(join(root, 'package.json'), { name: 'consumer', private: true, workspaces: ['packages/*'] });
  const evil = join(root, 'packages', 'x\n::error::raised');
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(root, 'target.json'), '{}');
  symlinkSync(join(root, 'target.json'), join(evil, 'package.json'));
  assert.throws(() => checkRepository(root, set({ '@kontourai/surface': '6.1.0' })), (error) => {
    assert.doesNotMatch(error.message, /\n/u);
    assert.match(error.message, /\\u000a::error::raised/u);
    return true;
  });
});

test('an unexpected error is escaped as a whole line and exits 2', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }));
  const consumer = join(dir, 'consumer');
  writeJson(join(consumer, 'package.json'), { name: 'consumer', dependencies: { '@kontourai/surface': '1.0.0' } });
  // A directory as the summary file: appendFileSync fails with EISDIR, an fs
  // error whose message carries the raw path.
  const summary = join(dir, 's\n::error::unexpected');
  mkdirSync(summary);
  const run = drift(['--set', setPath, '--fail-on', 'stale', '--markdown-summary', summary, consumer]);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /unexpected error: EISDIR.*\\u000a::error::unexpected/u);
  assertNoWorkflowCommand(run.stderr);
});

// Plain printable :: is enough to start a workflow command when it begins a
// line, so every line the script writes starts with fixed text. Each case
// puts a caller-controlled value where it would otherwise lead a line.
test('a plain ::error:: in a path, label or argument never leads an output line', (t) => {
  const dir = scratch(t);
  const run = (args) => spawnSync(process.execPath, [DRIFT, ...args], { encoding: 'utf8', cwd: dir });
  writeJson(join(dir, 'version-set.json'), set({ '@kontourai/surface': '6.1.0' }));

  // A workspace directory named ::error::spoof holding a symlinked manifest.
  const consumer = join(dir, 'consumer');
  writeJson(join(consumer, 'package.json'), { name: 'consumer', private: true, workspaces: ['*'] });
  mkdirSync(join(consumer, '::error::spoof'));
  writeFileSync(join(dir, 'target.json'), '{}');
  symlinkSync(join(dir, 'target.json'), join(consumer, '::error::spoof', 'package.json'));
  let result = run(['--set', 'version-set.json', 'consumer']);
  assert.equal(result.status, 2, result.stdout);
  assert.equal(result.stderr, 'error: ::error::spoof/package.json: is a symlink; refusing to follow it\n');

  // A label.
  const plain = join(dir, 'plain');
  writeJson(join(plain, 'package.json'), { name: 'plain', dependencies: { '@kontourai/surface': '1.0.0' } });
  result = run(['--set', 'version-set.json', '--label', '::error::x', 'plain']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Repository ::error::x: 1 @kontourai specs/mu);
  assertNoWorkflowCommand(result.stdout, result.stderr);

  // A checkout argument that does not exist.
  result = run(['--set', 'version-set.json', '::error::nonexist']);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, 'error: ::error::nonexist: no such directory\n');

  // A set path that does not exist.
  result = run(['--set', '::error::noset.json', 'plain']);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, 'error: ::error::noset.json: cannot be read (ENOENT)\n');
});

test('a symlink loop or a non-object manifest exits 2, not 1', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }));
  const loop = join(dir, 'loop');
  writeJson(join(loop, 'package.json'), { name: 'loop', private: true, workspaces: ['packages/*'] });
  mkdirSync(join(loop, 'packages'));
  symlinkSync('loop', join(loop, 'packages/loop'));
  let run = drift(['--set', setPath, '--fail-on', 'stale', loop]);
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /packages\/loop: cannot be resolved \(ELOOP\)/u);

  for (const [name, content, message] of [
    ['null', 'null', /package\.json: must be a JSON object/u],
    ['array', '[]', /package\.json: must be a JSON object/u],
    ['section', '{"dependencies": null}', /package\.json: dependencies must be an object/u],
  ]) {
    const root = join(dir, name);
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), content);
    run = drift(['--set', setPath, '--fail-on', 'stale', root]);
    assert.equal(run.status, 2, `${name}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, message);
  }
});

// A format change bumps schemaVersion on main. Callers pinned to an older
// script must not go red in advisory mode; a gate cannot be evaluated, so it
// refuses.
test('a newer schemaVersion warns and exits 0 in advisory mode, 2 under --fail-on', (t) => {
  const dir = scratch(t);
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, { schemaVersion: 2, trains: [] });
  const consumer = join(dir, 'consumer');
  writeJson(join(consumer, 'package.json'), { name: 'consumer', dependencies: { '@kontourai/surface': '1.0.0' } });
  const summary = join(dir, 'summary.md');
  let run = drift(['--set', setPath, '--markdown-summary', summary, consumer], { ...process.env, GITHUB_ACTIONS: 'true' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /schemaVersion 2 is newer than this script reads \(1\)/u);
  // Pinned literal: the annotation carries only fixed text.
  assert.equal(run.stdout, '::warning title=Version-set drift skipped::The version set uses a newer schemaVersion '
    + 'than this pinned drift script reads. Drift was not checked; re-pin the version-set-drift workflow to pick up '
    + 'the newer reader.\n');
  assert.match(readFileSync(summary, 'utf8'), /Drift was not checked/u);

  run = drift(['--set', setPath, '--fail-on', 'stale', consumer]);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /^error: .*newer than this script reads/u);
  assert.doesNotMatch(run.stderr, /Usage:/u);

  // A malformed schemaVersion is still an error, not a newer format.
  writeJson(setPath, { schemaVersion: 'two' });
  run = drift(['--set', setPath, consumer]);
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
  assert.match(text, /`kontourai\/consumer`: 0 current, 1 behind/u);
  assert.match(text, /\| `\^3\.0\.0 \\\|\\\| \^4\.0\.0` \|/u);
});

test('--all clones each listed consumer and checks its manifests', (t) => {
  const dir = scratch(t);
  const source = join(dir, 'src');
  writeJson(join(source, 'package.json'), { name: 'consumer', private: true, workspaces: ['pkg'] });
  writeJson(join(source, 'pkg/package.json'), { name: 'pkg', dependencies: { '@kontourai/surface': '5.0.0' } });
  writeFileSync(join(source, 'pkg/index.js'), 'export {};\n');
  // Isolated so that, run from a git hook, these commands cannot touch the
  // hook's repository through GIT_DIR.
  const env = isolatedGitEnvironment();
  const git = (...args) => execFileSync('git', args, { cwd: source, stdio: 'pipe', env });
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'init');
  execFileSync('git', ['clone', '--quiet', '--bare', source, join(dir, 'remote/kontourai/consumer.git')], { stdio: 'pipe', env });
  const setPath = join(dir, 'version-set.json');
  writeJson(setPath, set({ '@kontourai/surface': '6.1.0' }, { train: '2026.09-a', packages: { '@kontourai/surface': '5.0.0' } }));

  const gitBase = `${pathToFileURL(join(dir, 'remote')).href}/`;
  let run = drift(['--set', setPath, '--all', '--git-base', gitBase, '--json']);
  assert.equal(run.status, 0, run.stderr);
  const [result] = JSON.parse(run.stdout).results;
  assert.equal(result.repository, 'kontourai/consumer');
  assert.deepEqual(result.findings.map((f) => [f.manifest, f.status]), [['pkg/package.json', 'behind']]);

  // Run as a git hook runs it: GIT_DIR names another repository. The clones
  // must still land in scratch and leave that repository untouched.
  const decoy = join(dir, 'decoy');
  mkdirSync(decoy);
  execFileSync('git', ['init', '--quiet'], { cwd: decoy, env });
  const decoyGit = join(decoy, '.git');
  const before = readFileSync(join(decoyGit, 'config'), 'utf8');
  run = drift(['--set', setPath, '--all', '--git-base', gitBase, '--json'], { ...process.env, GIT_DIR: decoyGit, GIT_WORK_TREE: decoy });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout).results[0].findings.map((f) => f.status), ['behind']);
  assert.equal(readFileSync(join(decoyGit, 'config'), 'utf8'), before);
  assert.equal(spawnSync('git', ['-C', decoy, 'status', '--porcelain'], { encoding: 'utf8', env }).stdout, '');

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
