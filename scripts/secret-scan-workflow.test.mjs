import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('../.github/workflows/secret-scan.yml', import.meta.url),
);

// Pulls the literal `run: |` block body out of the "Fail closed if checkout
// is shallow" step so behavior tests exercise the exact script the workflow
// runs, not a hand-copied stand-in that could drift from it.
function extractShallowGuardScript(workflow) {
  const stepIndex = workflow.indexOf('- name: Fail closed if checkout is shallow');
  assert.ok(stepIndex !== -1, 'expected the shallow-guard step to exist');

  const runIndex = workflow.indexOf('run: |', stepIndex);
  assert.ok(runIndex !== -1, 'expected the shallow-guard step to have a run block');

  const bodyStart = workflow.indexOf('\n', runIndex) + 1;
  const nextStepIndex = workflow.indexOf('\n      - name:', bodyStart);
  const bodyEnd = nextStepIndex === -1 ? workflow.length : nextStepIndex;
  const rawBody = workflow.slice(bodyStart, bodyEnd);

  const lines = rawBody.split('\n').filter((line) => line.trim() !== '');
  const indent = Math.min(
    ...lines.map((line) => line.match(/^ */)[0].length),
  );
  assert.ok(indent >= 10, 'expected the run block to be indented under the step');

  return lines.map((line) => line.slice(indent)).join('\n');
}

async function runShallowGuard(script, { gitScript }) {
  const dir = await mkdtemp(join(tmpdir(), 'shallow-guard-'));
  try {
    const binDir = join(dir, 'bin');
    await mkdir(binDir);
    await writeFile(join(binDir, 'git'), `#!/usr/bin/env bash\n${gitScript}\n`, {
      mode: 0o755,
    });
    await writeFile(join(dir, 'guard.sh'), script, { mode: 0o644 });

    return spawnSync('bash', [join(dir, 'guard.sh')], {
      cwd: dir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('secret scan is limited to complete history reachable from checkout HEAD', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  // gitleaks v8.30.1 passes --log-opts directly to `git log`; HEAD therefore
  // replaces its default --all traversal while retaining all HEAD ancestors.
  assert.match(
    workflow,
    /gitleaks git \. --log-opts=HEAD --redact --no-banner --verbose/,
  );
  assert.doesNotMatch(workflow, /gitleaks git \. .*--all/);
  assert.doesNotMatch(workflow, /--exit-code(?:=|\s+)0/);
});

test('checkout fetch-depth is hardcoded to full history and not caller-configurable', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  // Callers must never be able to request a shallow checkout: gitleaks needs
  // complete reachable history, and a caller-supplied fetch-depth input would
  // let a shallow checkout silently under-scan.
  assert.doesNotMatch(workflow, /fetch-depth:\s*\n?\s*description/);
  assert.doesNotMatch(workflow, /inputs\.fetch-depth/);
  assert.match(workflow, /fetch-depth:\s*0\s*$/m);
});

test('scan fails closed if the checkout is shallow', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /git rev-parse --is-shallow-repository/);

  const checkoutIndex = workflow.indexOf('uses: actions/checkout');
  const guardIndex = workflow.indexOf('git rev-parse --is-shallow-repository');
  const scanIndex = workflow.indexOf('gitleaks git . --log-opts=HEAD');

  assert.ok(checkoutIndex !== -1, 'expected a checkout step');
  assert.ok(
    checkoutIndex < guardIndex && guardIndex < scanIndex,
    'the shallow-repository guard must run after checkout and before the scan',
  );
});

test('shallow-repository guard captures the command result before testing it', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  // The check must be a plain assignment (`set -e` catches a failing
  // command there) rather than a command substitution embedded directly
  // in the `if` condition (`set -e` does not apply inside a tested
  // condition, so a `git` failure would be silently swallowed).
  assert.match(workflow, /shallow="\$\(git rev-parse --is-shallow-repository\)"/);
  assert.doesNotMatch(
    workflow,
    /if \[ "\$\(git rev-parse --is-shallow-repository\)"/,
    'the git invocation must not live inside the if test condition',
  );
});

test('shallow-repository guard accepts only the exact value "false"', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  // Reject on anything other than an exact "false" — including "true", an
  // empty string, and any unrecognized value — rather than only checking
  // for "true" and defaulting everything else to pass.
  assert.match(workflow, /if \[ "\$\{shallow\}" != "false" \]; then/);
  assert.doesNotMatch(
    workflow,
    /if \[ "\$\{shallow\}" = "true" \]; then/,
    'the guard must reject anything other than "false", not just "true"',
  );
});

test('shallow-repository guard shell behavior: accepts an exact "false"', async () => {
  const script = extractShallowGuardScript(await readFile(workflowPath, 'utf8'));
  const result = await runShallowGuard(script, {
    gitScript: 'echo false',
  });

  assert.equal(result.status, 0, result.stderr);
});

test('shallow-repository guard shell behavior: rejects "true"', async () => {
  const script = extractShallowGuardScript(await readFile(workflowPath, 'utf8'));
  const result = await runShallowGuard(script, {
    gitScript: 'echo true',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to run/);
});

test('shallow-repository guard shell behavior: rejects an unexpected value', async () => {
  const script = extractShallowGuardScript(await readFile(workflowPath, 'utf8'));
  const result = await runShallowGuard(script, {
    gitScript: 'echo banana',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to run/);
});

test('shallow-repository guard shell behavior: fails closed when git itself errors', async () => {
  const script = extractShallowGuardScript(await readFile(workflowPath, 'utf8'));
  const result = await runShallowGuard(script, {
    gitScript: 'echo "fatal: not a git repository" >&2\nexit 128',
  });

  assert.notEqual(result.status, 0);
  // The script aborts on the command failure itself (via `set -e`) before
  // ever reaching the custom refusal message; the important assertion is
  // that a git error still exits non-zero, not the exact message shown.
});

test('shallow-repository guard shell behavior: fails closed on empty git output', async () => {
  const script = extractShallowGuardScript(await readFile(workflowPath, 'utf8'));
  const result = await runShallowGuard(script, {
    gitScript: 'true',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to run/);
});
