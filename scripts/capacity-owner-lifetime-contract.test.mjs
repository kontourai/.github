import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

const OWNER_LIFETIME_SECONDS = 7_800;
const STATION_MAXIMUM_JOB_SECONDS = 125 * 60;
const RECOVERY_MARGIN_SECONDS = 5 * 60;
const capacityActionUrl = new URL('../actions/physical-host-capacity/action.yml', import.meta.url);
const terminalRecoveryActionUrl = new URL(
  '../actions/recover-terminal-capacity-owner/action.yml',
  import.meta.url,
);
const coordinatorUrl = new URL('../actions/physical-host-capacity/coordinator.mjs', import.meta.url);
const provisionUrl = new URL('../scripts/provision-physical-host-capacity.mjs', import.meta.url);
const recoveryUrl = new URL('../scripts/recover-physical-host-capacity.mjs', import.meta.url);
const terminalRecoveryUrl = new URL('../scripts/recover-terminal-capacity-owner.mjs', import.meta.url);
const workflowUrl = new URL('../.github/workflows/secret-scan.yml', import.meta.url);
const readmeUrl = new URL('../README.md', import.meta.url);

test('the Station host-wide owner-lifetime contract remains 125 minutes plus recovery margin', async () => {
  assert.equal(
    OWNER_LIFETIME_SECONDS,
    STATION_MAXIMUM_JOB_SECONDS + RECOVERY_MARGIN_SECONDS,
  );

  const [capacityAction, terminalRecoveryAction, coordinator, provision, recovery, terminalRecovery] =
    await Promise.all([
      readFile(capacityActionUrl, 'utf8').then(parse),
      readFile(terminalRecoveryActionUrl, 'utf8').then(parse),
      readFile(coordinatorUrl, 'utf8'),
      readFile(provisionUrl, 'utf8'),
      readFile(recoveryUrl, 'utf8'),
      readFile(terminalRecoveryUrl, 'utf8'),
    ]);

  assert.equal(capacityAction.inputs['owner-lifetime-seconds'].default, String(OWNER_LIFETIME_SECONDS));
  assert.equal(terminalRecoveryAction.inputs['owner-lifetime-seconds'].default, String(OWNER_LIFETIME_SECONDS));
  assert.match(coordinator, /LEGACY_OWNER_LIFETIME_FLOOR_MS = 7_800_000/);
  for (const script of [provision, recovery, terminalRecovery]) {
    assert.match(script, /owner-lifetime-seconds'\] \?\? '7800'/);
  }
});

test('the reusable secret scan rejects the retired 6000-second value on self-hosted hosts', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /default: 7800/);
  assert.match(workflow, /inputs\.capacity-owner-lifetime-seconds != 7800/);
  assert.doesNotMatch(workflow, /inputs\.capacity-owner-lifetime-seconds != 6000/);
  assert.match(workflow, /shared 7800-second owner lifetime/);
});

test('operator and reusable-workflow documentation specify the same owner lifetime', async () => {
  const [workflow, readme] = await Promise.all([
    readFile(workflowUrl, 'utf8'),
    readFile(readmeUrl, 'utf8'),
  ]);

  assert.match(workflow, /fixed at 7800 seconds for the Station 125-minute timeout plus five-minute recovery margin/);
  assert.match(readme, /owner-lifetime-seconds: '7800' # shared 125-minute maximum plus 5-minute recovery margin/);
  assert.match(readme, /The shared default is 7800\nseconds: Station's 125-minute maximum job timeout plus five minutes of recovery\nmargin/);
  assert.match(readme, /reusable workflow fixes `capacity-owner-lifetime-seconds` at 7800 seconds/);
  assert.match(readme, /migrate-physical-host-owner-lifetime\.mjs/);
  assert.match(readme, /--old-owner-lifetime-seconds 6000/);
  assert.doesNotMatch(readme, /shared default is 6000/i);
});
