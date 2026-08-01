import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
  new URL('../.github/workflows/secret-scan.yml', import.meta.url),
);

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
