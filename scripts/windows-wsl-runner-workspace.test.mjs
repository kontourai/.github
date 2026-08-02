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
  assert.match(script, /\[string\]\$WslWindowsUser = \[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.match(script, /Assert-Administrator/);
  assert.match(script, /Refusing to overwrite existing VHD/);
  assert.match(script, /wsl\.exe --mount \$VhdPath --vhd --bare/);
  assert.match(script, /wsl\.exe --distribution \$DistroName --user root -- bash -lc \$WslBootstrapCommand/);
  assert.match(script, /InstallBootTask requires WslBootstrapCommand/);
  assert.match(script, /-Mode AttachAndBootstrap/);
  assert.match(script, /Attach-WorkspaceVhd -AllowAlreadyAttached/);
  assert.match(script, /UUID bootstrap validated it before services were started/);
  assert.doesNotMatch(script, /Mount-DiskImage|Get-DiskImage|Set-Disk/);
  assert.match(script, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$WslWindowsUser/);
  assert.match(script, /New-ScheduledTaskPrincipal -UserId \$WslWindowsUser -LogonType Interactive -RunLevel Highest/);
  assert.match(script, /wsl\.exe --list --quiet/);
  assert.match(script, /WSL distribution \$DistroName is not registered for Windows user \$WslWindowsUser/);
  assert.doesNotMatch(script, /UserId 'SYSTEM'/);
  assert.match(script, /Optimize-VHD -Path \$VhdPath -Mode Full/);
  assert.match(script, /Compaction requires -ConfirmIdle and -ConfirmDetached/);
  assert.doesNotMatch(script, /Station/i);
});

test('storage hooks fail before job steps, retain bounded usage, and clean only marked scratch', async () => {
  const hook = await readFile(storageHook, 'utf8');
  const installer = await readFile(hookInstaller, 'utf8');
  const idle = await readFile(maintenance, 'utf8');

  assert.match(hook, /preflight --workspace-root PATH --headroom-path PATH/);
  assert.match(hook, /minimum-free-gb/);
  assert.match(hook, /filesystem_used_bytes/);
  assert.doesNotMatch(hook, /du -sxB1/);
  assert.match(hook, /flock -x 9/);
  assert.match(hook, /mktemp "\$\{usage_log\}\.tmp\.XXXXXX"/);
  assert.match(hook, /tail -n "\$usage_log_lines"/);
  assert.match(hook, /\.kontour-ephemeral-job/);
  assert.match(hook, /rm -rf --one-file-system/);
  assert.match(hook, /refusing to remove unmarked path/);
  assert.match(installer, /--runner-root PATH \[--runner-root PATH \.\.\.\]/);
  assert.match(installer, /ACTIONS_RUNNER_HOOK_JOB_STARTED/);
  assert.match(installer, /ACTIONS_RUNNER_HOOK_JOB_COMPLETED/);
  assert.match(idle, /--confirm-idle/);
  assert.match(idle, /unknown service unit/);
  assert.match(idle, /service is not explicitly inactive/);
  assert.match(idle, /systemctl mask --runtime/);
  assert.match(idle, /Runner\.Worker or Runner\.Listener/);
  assert.match(idle, /fstrim -v/);
  assert.doesNotMatch(hook + installer + idle, /Station/i);
});

test('WSL bootstrap mounts by UUID, validates bindings, then starts services', async () => {
  const script = await readFile(bootstrapScript, 'utf8');

  assert.match(script, /--uuid UUID --mount-root PATH/);
  assert.match(script, /blkid -U "\$uuid"/);
  assert.match(script, /mount -U "\$uuid" "\$mount_root"/);
  assert.match(script, /mount root must be canonical and may not traverse symlinks/);
  assert.match(script, /source must be below mount root/);
  assert.match(script, /binding paths must be canonical and may not traverse symlinks/);
  assert.match(script, /source is not on the recorded UUID filesystem/);
  assert.match(script, /findmnt -no UUID --target "\$target_path"/);
  assert.match(script, /findmnt -no FSROOT --target "\$target_path"/);
  assert.match(script, /target already has a different mount identity/);
  assert.doesNotMatch(script, /findmnt -no SOURCE --target "\$target_path"/);
  assert.match(script, /mount --bind "\$source_path" "\$target_path"/);
  assert.match(script, /systemctl start "\$service"/);
  assert.doesNotMatch(script, /Station/i);
});

test('runbook preserves the Windows-path and WSL-UUID recovery boundary', async () => {
  const text = await readFile(runbook, 'utf8');

  assert.match(text, /refuses to overwrite/i);
  assert.match(text, /mounts by the recorded ext4 UUID/i);
  assert.match(text, /wsl\.exe --mount --vhd --bare/);
  assert.match(text, /WslBootstrapCommand/);
  assert.match(text, /WSL-owning Windows user/i);
  assert.match(text, /logon trigger is authoritative/i);
  assert.match(text, /UUID and filesystem root/i);
  assert.match(text, /manual, destructive confirmation step/i);
  assert.match(text, /stop the runner\s+services/i);
  assert.match(text, /Storage lifecycle hooks/);
  assert.match(text, /ACTIONS_RUNNER_HOOK_JOB_STARTED/);
  assert.match(text, /does not delete workspaces,\s*dependency caches,[\s\S]*semantic receipts/i);
  assert.match(text, /runtime-masks/i);
});
