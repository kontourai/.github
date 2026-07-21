#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const RELEASE_PLEASE_REPOSITORIES = Object.freeze([
  'kontourai/bearing', 'kontourai/console', 'kontourai/datum', 'kontourai/flow-agents',
  'kontourai/flow', 'kontourai/forage', 'kontourai/lookout', 'kontourai/plumb',
  'kontourai/surface', 'kontourai/survey', 'kontourai/traverse', 'kontourai/ui',
  'kontourai/veritas',
]);

export function assessSettings(settings) {
  if (!settings.allow_merge_commit) return { compliant: true, reason: 'merge commits disabled' };
  const title = settings.merge_commit_title || 'unset';
  const message = settings.merge_commit_message || 'unset';
  if (title === 'PR_TITLE' && message === 'BLANK') {
    return { compliant: true, reason: 'merge uses the neutral PR title and has a blank body' };
  }
  return { compliant: false, reason: `merge title/body are ${title}/${message}; expected PR_TITLE/BLANK` };
}

export function patchArguments(repository) {
  return [
    'api', '--method', 'PATCH', `repos/${repository}`,
    '-f', 'merge_commit_title=PR_TITLE', '-f', 'merge_commit_message=BLANK',
  ];
}

function readSettings(repository, run = execFileSync) {
  return JSON.parse(run('gh', ['api', `repos/${repository}`], { encoding: 'utf8' }));
}

export function enforceRepository(repository, { apply = false, run = execFileSync } = {}) {
  const assessment = assessSettings(readSettings(repository, run));
  if (assessment.compliant || !apply) return { repository, changed: false, ...assessment };
  run('gh', patchArguments(repository), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const verified = assessSettings(readSettings(repository, run));
  if (!verified.compliant) throw new Error(`${repository}: policy update did not take effect: ${verified.reason}`);
  return { repository, changed: true, ...verified };
}

function main(argv = process.argv.slice(2)) {
  const [mode, ...targets] = argv;
  if (!['check', 'apply'].includes(mode) || targets.length === 0) {
    process.stderr.write('Usage: node scripts/release-note-policy.mjs <check|apply> <--suite|owner/repo...>\n');
    return 2;
  }
  if (targets.includes('--suite') && targets.length !== 1) {
    process.stderr.write('--suite cannot be combined with explicit repositories\n');
    return 2;
  }
  const repositories = targets[0] === '--suite' ? RELEASE_PLEASE_REPOSITORIES : targets;
  let failures = 0;
  for (const repository of repositories) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      process.stderr.write(`${repository}: invalid owner/repository identifier\n`);
      failures += 1;
      continue;
    }
    const result = enforceRepository(repository, { apply: mode === 'apply' });
    const state = result.compliant ? (result.changed ? 'UPDATED' : 'PASS') : 'FAIL';
    process.stdout.write(`${state} ${repository}: ${result.reason}\n`);
    if (!result.compliant) failures += 1;
  }
  return failures === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
