import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const windowsScript = fileURLToPath(new URL('../runner-host/windows-wsl-runner-workspace.ps1', import.meta.url));
const bootstrapScript = fileURLToPath(new URL('../runner-host/bootstrap-wsl-runner-workspace.sh', import.meta.url));
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
  assert.doesNotMatch(script, /Station/i);
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
});
