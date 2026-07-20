import assert from 'node:assert/strict';
import test from 'node:test';

import { DefaultChangelogNotes } from 'release-please/build/src/changelog-notes/default.js';
import { parseConventionalCommits } from 'release-please/build/src/commit.js';

import { assessSettings, enforceRepository, patchArguments, RELEASE_PLEASE_REPOSITORIES } from './release-note-policy.mjs';

test('blank merge bodies satisfy the release-note policy', () => {
  assert.equal(assessSettings({ allow_merge_commit: true, merge_commit_title: 'MERGE_MESSAGE', merge_commit_message: 'BLANK' }).compliant, true);
  assert.equal(assessSettings({ allow_merge_commit: false, merge_commit_message: 'PR_TITLE' }).compliant, true);
});

test('conventional PR titles in either merge field are rejected', () => {
  assert.deepEqual(assessSettings({ allow_merge_commit: true, merge_commit_title: 'MERGE_MESSAGE', merge_commit_message: 'PR_TITLE' }), {
    compliant: false,
    reason: 'merge title/body are MERGE_MESSAGE/PR_TITLE; expected MERGE_MESSAGE/BLANK',
  });
  assert.equal(assessSettings({ allow_merge_commit: true, merge_commit_title: 'PR_TITLE', merge_commit_message: 'BLANK' }).compliant, false);
});

test('apply patches only the merge body policy and verifies the result', () => {
  const calls = [];
  const responses = [
    JSON.stringify({ allow_merge_commit: true, merge_commit_title: 'MERGE_MESSAGE', merge_commit_message: 'PR_TITLE' }),
    '{}',
    JSON.stringify({ allow_merge_commit: true, merge_commit_title: 'MERGE_MESSAGE', merge_commit_message: 'BLANK' }),
  ];
  const run = (command, args) => {
    calls.push([command, args]);
    return responses.shift();
  };
  assert.equal(enforceRepository('kontourai/example', { apply: true, run }).changed, true);
  assert.deepEqual(calls[1], ['gh', patchArguments('kontourai/example')]);
});

test('Release Please emits one attributed fix after a normal merge with the suite policy', async () => {
  const commits = parseConventionalCommits([
    { sha: 'merge', message: 'Merge pull request #42 from kontourai/fix/example' },
    { sha: 'child', message: 'fix: retain attribution (#42)' },
  ]);
  const notes = await new DefaultChangelogNotes().buildNotes(commits, {
    owner: 'kontourai', repository: 'example', version: '1.0.1',
    previousTag: 'v1.0.0', currentTag: 'v1.0.1', targetBranch: 'main',
  });
  assert.equal(commits.length, 1);
  assert.equal(notes.match(/retain attribution/g)?.length, 1);
  assert.match(notes, /\[#42\]\(https:\/\/github\.com\/kontourai\/example\/issues\/42\)/);
});

test('suite target names every public repository currently using Release Please', () => {
  assert.equal(RELEASE_PLEASE_REPOSITORIES.length, 13);
  assert.equal(new Set(RELEASE_PLEASE_REPOSITORIES).size, RELEASE_PLEASE_REPOSITORIES.length);
});
