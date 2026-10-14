import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const VERITAS_VERSION = '1.11.1';
const gitStatus = root => execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
const gitHead = root => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

export async function captureReadiness({ root, base, head, runId, output, requireReady = false, installExitCode = null }, { runMergeReadiness, feedbackHasFailures, sourceHead = gitHead, sourceStatus = gitStatus }) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const envelope = { schema: 'kontour.github.veritas_execution', version: '1.0', veritas_version: VERITAS_VERSION, base, head, run_id: runId, require_ready: requireReady, installation_exit_code: installExitCode, source_before: null, source_after: null, verdict: 'ERROR', exit_code: 2, evidence_check_results: [] };
  try {
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) throw new Error('Exact base and head commit SHAs required');
    if (!/^github-[0-9]+-[0-9]+$/.test(runId)) throw new Error('Bound GitHub run ID and attempt required');
    envelope.source_before = sourceHead(root);
    if (envelope.source_before !== head) throw new Error('Checkout does not match requested head');
    envelope.tracked_changes_before = sourceStatus(root);
    if (envelope.tracked_changes_before) throw new Error('Tracked source is dirty before readiness');
    // Evidence timeouts and required scopes remain owned by the caller Repo Map.
    const result = await runMergeReadiness({ rootDir: root, changedFrom: base, changedTo: head, runId });
    envelope.source_after = sourceHead(root);
    envelope.evidence_check_results = result.evidenceCheckResults;
    envelope.evidence_check_failure = result.evidenceCheckFailure;
    envelope.report = result.reportResult.record;
    envelope.tracked_changes_after = sourceStatus(root);
    envelope.source_unchanged = envelope.source_after === head && !envelope.tracked_changes_after;
    envelope.verdict = envelope.source_unchanged && !feedbackHasFailures(envelope.report, result.evidenceCheckFailure) ? 'PASS' : 'FAIL';
    envelope.exit_code = envelope.verdict === 'PASS' ? 0 : 1;
  } catch (error) {
    envelope.error = { name: error.name, message: error.message };
  }
  await writeFile(path.join(output, 'execution.json'), JSON.stringify(envelope, null, 2) + '\n', { mode: 0o600 });
  const transcript = envelope.evidence_check_results.map(check => `== ${check.label} ==\n${check.stdout ?? ''}\n${check.stderr ?? ''}`).join('\n');
  await writeFile(path.join(output, 'checks.log'), transcript, { mode: 0o600 });
  return { envelope, jobExitCode: envelope.verdict === 'ERROR' || requireReady ? envelope.exit_code : 0 };
}

export async function loadPublishedApi(environment) {
  if (environment.VERITAS_INSTALL_EXIT_CODE !== '0') throw new Error(`Published Veritas installation failed or is unobserved (exit ${environment.VERITAS_INSTALL_EXIT_CODE ?? 'unknown'})`);
  const packageRoot = environment.VERITAS_PACKAGE_ROOT;
  const require = createRequire(path.join(packageRoot, 'package.json'));
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'node_modules/@kontourai/veritas/package.json'), 'utf8'));
  if (metadata.version !== VERITAS_VERSION) throw new Error('Published Veritas version mismatch');
  return import(pathToFileURL(require.resolve('@kontourai/veritas')).href);
}

export async function main(environment = process.env) {
  let api;
  try {
    api = await loadPublishedApi(environment);
  } catch (error) {
    // Preserve a structured ERROR even when installation/import failed.
    api = { runMergeReadiness: async () => { throw error; }, feedbackHasFailures: () => true };
  }
  const result = await captureReadiness({ root: process.cwd(), base: environment.BASE_SHA, head: environment.HEAD_SHA, runId: `github-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`, output: environment.VERITAS_OUTPUT_DIR, requireReady: environment.REQUIRE_READY === 'true', installExitCode: environment.VERITAS_INSTALL_EXIT_CODE ?? null }, api);
  console.log(`Actual Veritas readiness: ${result.envelope.verdict}; source ${result.envelope.head}; exit ${result.envelope.exit_code}`);
  if (environment.GITHUB_STEP_SUMMARY) await writeFile(environment.GITHUB_STEP_SUMMARY, `Actual Veritas readiness: **${result.envelope.verdict}** (exit ${result.envelope.exit_code}).\n\nExact source: ${result.envelope.base} → ${result.envelope.head}.\n\n${result.envelope.require_ready ? 'This caller requires a ready verdict.' : 'Observe-only: this verdict does not change the caller enforcement policy.'}\n`, { flag: 'a' });
  process.exitCode = result.jobExitCode;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error); process.exitCode = 2; });
