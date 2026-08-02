import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const windowsScript = fileURLToPath(new URL('../runner-host/windows-wsl-runner-workspace.ps1', import.meta.url));
const bootstrapScript = fileURLToPath(new URL('../runner-host/bootstrap-wsl-runner-workspace.sh', import.meta.url));
const storageHook = fileURLToPath(new URL('../runner-host/runner-storage-hook.sh', import.meta.url));
const hookInstaller = fileURLToPath(new URL('../runner-host/install-runner-storage-hooks.sh', import.meta.url));
const maintenance = fileURLToPath(new URL('../runner-host/idle-runner-storage-maintenance.sh', import.meta.url));
const runbook = fileURLToPath(new URL('../runner-host/README.md', import.meta.url));

test('Windows VHD helper is parameterized, elevated, and refuses overwrite', async () => {
  const script = await readFile(windowsScript, 'utf8');

  assert.match(script, /\[string\]\$VhdPath/);
  assert.match(script, /\[int\]\$VhdSizeGB = 48/);
  assert.match(script, /\[string\]\$DistroName = 'Ubuntu'/);
  assert.match(script, /Assert-Administrator/);
  assert.match(script, /Refusing to overwrite existing VHD/);
  assert.match(script, /Mount-DiskImage -ImagePath \$VhdPath -NoDriveLetter/);
  assert.match(script, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(script, /Optimize-VHD -Path \$VhdPath -Mode Full/);
  assert.match(script, /Compaction requires -ConfirmIdle/);
  assert.doesNotMatch(script, /Station/i);
});

test('storage hooks fail before job steps, retain bounded usage, and clean only marked scratch', async () => {
  const hook = await readFile(storageHook, 'utf8');
  const installer = await readFile(hookInstaller, 'utf8');
  const idle = await readFile(maintenance, 'utf8');

  assert.match(hook, /preflight --workspace-root PATH --headroom-path PATH/);
  assert.match(hook, /minimum-free-gb/);
  assert.match(hook, /tail -n "\$usage_log_lines"/);
  assert.match(hook, /\.kontour-ephemeral-job/);
  assert.match(hook, /rm -rf --one-file-system/);
  assert.match(hook, /refusing to remove unmarked path/);
  assert.match(installer, /--runner-root PATH \[--runner-root PATH \.\.\.\]/);
  assert.match(installer, /ACTIONS_RUNNER_HOOK_JOB_STARTED/);
  assert.match(installer, /ACTIONS_RUNNER_HOOK_JOB_COMPLETED/);
  assert.match(idle, /--confirm-idle/);
  assert.match(idle, /Runner\.Worker/);
  assert.match(idle, /fstrim -v/);
  assert.doesNotMatch(hook + installer + idle, /Station/i);
});

test('WSL bootstrap mounts by UUID, validates bindings, then starts services', async () => {
  const script = await readFile(bootstrapScript, 'utf8');

  assert.match(script, /--uuid UUID --mount-root PATH/);
  assert.match(script, /blkid -U "\$uuid"/);
  assert.match(script, /mount -U "\$uuid" "\$mount_root"/);
  assert.match(script, /source must be below mount root/);
  assert.match(script, /target already has a different mount/);
  assert.match(script, /mount --bind "\$source_path" "\$target_path"/);
  assert.match(script, /systemctl start "\$service"/);
  assert.doesNotMatch(script, /Station/i);
});

test('runbook preserves the Windows-path and WSL-UUID recovery boundary', async () => {
  const text = await readFile(runbook, 'utf8');

  assert.match(text, /refuses to overwrite/i);
  assert.match(text, /mounts by the recorded ext4 UUID/i);
  assert.match(text, /manual, destructive confirmation step/i);
  assert.match(text, /stop the runner services/i);
  assert.match(text, /Storage lifecycle hooks/);
  assert.match(text, /ACTIONS_RUNNER_HOOK_JOB_STARTED/);
  assert.match(text, /does not delete workspaces, dependency caches,[\s\S]*semantic receipts/i);
});
