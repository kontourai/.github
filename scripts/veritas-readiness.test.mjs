import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureReadiness, VERITAS_VERSION, loadPublishedApi } from '../actions/veritas-readiness/run.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veritas-readiness-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, base, head, runId: 'github-123-2', output: path.join(root, 'capture'), ...extra };
}
function api(failed = false, extra = {}) {
  return { sourceHead: () => head, sourceStatus: () => '', feedbackHasFailures: () => failed,
    runMergeReadiness: async options => {
      assert.deepEqual(options, { rootDir: options.rootDir, changedFrom: base, changedTo: head, runId: 'github-123-2' });
      assert.equal('evidenceCheckTimeoutMs' in options, false);
      return { evidenceCheckResults: [{ label: 'repository gate', passed: !failed, stdout: 'complete returned stdout', stderr: 'complete returned stderr' }], evidenceCheckFailure: failed ? { reason: 'failed' } : null, reportResult: { record: { run_id: options.runId, baseline_ci_fast_passed: !failed } } };
    }, ...extra };
}
test('advisory retains the actual failed verdict, full returned output and private permissions', async t => {
  const f = await fixture(t); const result = await captureReadiness(f, api(true));
  assert.equal(result.jobExitCode, 0); assert.equal(result.envelope.verdict, 'FAIL'); assert.equal(result.envelope.exit_code, 1);
  assert.equal(result.envelope.veritas_version, VERITAS_VERSION); assert.equal(result.envelope.source_unchanged, true);
  const saved = JSON.parse(await readFile(path.join(f.output, 'execution.json'), 'utf8'));
  assert.equal(saved.evidence_check_results[0].stdout, 'complete returned stdout'); assert.equal(saved.evidence_check_results[0].stderr, 'complete returned stderr');
  assert.match(await readFile(path.join(f.output, 'checks.log'), 'utf8'), /complete returned stdout\ncomplete returned stderr/);
  assert.equal((await stat(f.output)).mode & 0o777, 0o700); assert.equal((await stat(path.join(f.output, 'execution.json'))).mode & 0o777, 0o600);
});
test('required readiness fails on actual failure and succeeds only on a ready result', async t => {
  for (const failed of [true, false]) {
    const r = await captureReadiness(await fixture(t, { requireReady: true }), api(failed));
    assert.equal(r.jobExitCode, failed ? 1 : 0); assert.equal(r.envelope.verdict, failed ? 'FAIL' : 'PASS');
  }
});
test('unknown execution errors always fail and retain structured diagnostics', async t => {
  const r = await captureReadiness(await fixture(t), api(false, { runMergeReadiness: async () => { throw new Error('unavailable gate'); } }));
  assert.equal(r.jobExitCode, 2); assert.equal(r.envelope.verdict, 'ERROR'); assert.equal(r.envelope.error.message, 'unavailable gate');
});
test('wrong checkout and malformed source binding refuse before invoking readiness', async t => {
  for (const extra of [{ head: 'main' }, { base: '' }, { runId: 'unbound' }, {}]) {
    let called = false;
    const r = await captureReadiness(await fixture(t, extra), api(false, { sourceHead: () => base, runMergeReadiness: async () => { called = true; } }));
    assert.equal(called, false); assert.equal(r.jobExitCode, 2);
  }
});
test('source drift cannot loan a successful readiness result', async t => {
  let calls = 0;
  const r = await captureReadiness(await fixture(t, { requireReady: true }), api(false, { sourceHead: () => ++calls === 1 ? head : base }));
  assert.equal(r.jobExitCode, 1); assert.equal(r.envelope.verdict, 'FAIL'); assert.equal(r.envelope.source_unchanged, false);
});
test('tracked source mutation refuses a pass even if HEAD is unchanged', async t => {
  let calls = 0;
  const r = await captureReadiness(await fixture(t, { requireReady: true }), api(false, { sourceStatus: () => ++calls === 1 ? '' : ' M source.mjs' }));
  assert.equal(r.jobExitCode, 1); assert.equal(r.envelope.source_unchanged, false);
});
test('reusable workflow keeps advisory default and binds the exact checkout and evidence scope', async () => {
  const workflow = await readFile(new URL('../.github/workflows/veritas-advisory.yml', import.meta.url), 'utf8');
  assert.match(workflow, /require-ready:[\s\S]*?type: boolean\s+default: false/);
  assert.match(workflow, /ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
  assert.match(workflow, /require-ready: \$\{\{ inputs.require-ready \}\}/);
  assert.match(workflow, /sudo apt-get install -y jq ripgrep/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /\$\{\{ env.VERITAS_OUTPUT_DIR \}\}/);
});

test('a failed partial installation cannot import a package or yield a PASS', async t => {
  const f = await fixture(t); const packageRoot = path.join(f.root, 'installed');
  const moduleRoot = path.join(packageRoot, 'node_modules/@kontourai/veritas');
  await mkdir(moduleRoot, { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), '{}');
  await writeFile(path.join(moduleRoot, 'package.json'), JSON.stringify({ name: '@kontourai/veritas', version: VERITAS_VERSION, type: 'module', exports: './index.mjs' }));
  await writeFile(path.join(moduleRoot, 'index.mjs'), 'export const importable = true;');
  const env = { VERITAS_PACKAGE_ROOT: packageRoot, VERITAS_INSTALL_EXIT_CODE: '0' };
  assert.equal((await loadPublishedApi(env)).importable, true);
  for (const code of ['1', 'unknown', undefined]) {
    await assert.rejects(loadPublishedApi({ ...env, VERITAS_INSTALL_EXIT_CODE: code }), /installation failed or is unobserved/);
    const result = await captureReadiness({ ...f, installExitCode: code }, api(false, { runMergeReadiness: async () => loadPublishedApi({ ...env, VERITAS_INSTALL_EXIT_CODE: code }) }));
    assert.equal(result.envelope.verdict, 'ERROR'); assert.equal(result.jobExitCode, 2);
  }
});
