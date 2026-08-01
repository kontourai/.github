import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

const smokeWorkflowUrl = new URL('../.github/workflows/self-hosted-runner-smoke.yml', import.meta.url);
const preflightActionUrl = new URL('../actions/runner-preflight/action.yml', import.meta.url);

test('fleet smoke routes by stable capability labels instead of host name', async () => {
  const workflow = parse(await readFile(smokeWorkflowUrl, 'utf8'));

  assert.deepEqual(workflow.jobs['linux-docker']['runs-on'], [
    'self-hosted',
    'Linux',
    'X64',
    'kontour-linux',
    'docker',
  ]);
  assert.deepEqual(workflow.jobs['windows-native']['runs-on'], [
    'self-hosted',
    'Windows',
    'X64',
    'kontour-windows',
    'native',
  ]);

  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'].includes('desktop-win'), false);
    assert.equal(job['timeout-minutes'], 10);
    const preflight = job.steps.find((step) => step.name === 'Verify runner capabilities');
    assert.match(preflight.uses, /^kontourai\/\.github\/actions\/runner-preflight@[0-9a-f]{40}$/);
  }
});

test('runner preflight verifies Docker only when explicitly required', async () => {
  const action = parse(await readFile(preflightActionUrl, 'utf8'));
  assert.equal(action.inputs['require-docker'].default, 'false');

  const dockerSteps = action.runs.steps.filter((step) => step.name.startsWith('Verify Docker'));
  assert.equal(dockerSteps.length, 2);
  for (const step of dockerSteps) {
    assert.match(step.if, /inputs\.require-docker == 'true'/);
    assert.match(step.run, /docker version/);
  }
});

test('Windows preflight enforces the documented native build-tool contract', async () => {
  const action = parse(await readFile(preflightActionUrl, 'utf8'));
  const windowsStep = action.runs.steps.find((step) => step.name === 'Report Windows runner');

  assert.match(windowsStep.run, /git --version/);
  assert.match(windowsStep.run, /node --version/);
  assert.match(windowsStep.run, /rustc --version/);
});
