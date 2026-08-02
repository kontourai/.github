import assert from 'node:assert/strict';
import { access as accessFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

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
  assert.match(script, /'AttachAndBootstrap'/);
  assert.match(script, /AttachBootstrapAndKeepAlive/);
  assert.match(script, /Attach-WorkspaceVhd -AllowAlreadyAttached/);
  assert.match(script, /UUID bootstrap validated it before services were started/);
  assert.match(script, /exec tail -f \/dev\/null/);
  assert.match(script, /WSL keepalive returned unexpectedly[\s\S]*exit code \$LASTEXITCODE/);
  assert.match(script, /New-ScheduledTaskSettingsSet -ExecutionTimeLimit \(New-TimeSpan -Seconds 0\) -RestartCount 3 -RestartInterval \(New-TimeSpan -Minutes 1\) -MultipleInstances IgnoreNew/);
  assert.match(script, /Install-ProtectedTaskEntrypoint/);
  assert.match(script, /TaskEntrypointPath = "\$env:ProgramData\\Kontour\\runner-host\\windows-wsl-runner-workspace\.ps1"/);
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(script, /ProgramData task-entrypoint ancestry is unsafe/);
  assert.match(script, /TaskEntrypointPath must be canonically under the real ProgramData directory/);
  assert.match(script, /TaskEntrypointPath must be a canonical Windows path without traversal/);
  assert.match(script, /GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/);
  assert.match(script, /Protected task entrypoint identity verification failed/);
  assert.match(script, /Protected task entrypoint hash verification failed/);
  assert.match(script, /Protected task entrypoint ACL verification failed/);
  assert.match(script, /missing administrator or SYSTEM write access/);
  assert.doesNotMatch(script, /Mount-DiskImage|Get-DiskImage|Set-Disk/);
  assert.match(script, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$WslWindowsUser/);
  assert.match(script, /New-ScheduledTaskPrincipal -UserId \$WslWindowsUser -LogonType Interactive -RunLevel Highest/);
  assert.match(script, /wsl\.exe --list --quiet/);
  assert.match(script, /WSL distribution \$DistroName is not registered for Windows user \$WslWindowsUser/);
  assert.doesNotMatch(script, /UserId 'SYSTEM'/);
  assert.match(script, /Optimize-VHD -Path \$VhdPath -Mode Full/);
  assert.match(script, /Compaction requires -ConfirmDrainActive and -ConfirmDetached/);
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
  assert.match(installer, /--runner-service-user USER/);
  assert.match(installer, /runuser -u "\$runner_service_user" -- test -w "\$usage_log_directory"/);
  assert.match(installer, /runuser -u "\$runner_service_user" -- test -w "\$usage_log"/);
  assert.match(installer, /ACTIONS_RUNNER_HOOK_JOB_STARTED/);
  assert.match(installer, /ACTIONS_RUNNER_HOOK_JOB_COMPLETED/);
  assert.match(idle, /begin --confirm-idle/);
  assert.match(idle, /--uuid UUID --mount-root PATH/);
  assert.match(idle, /--bind SOURCE:TARGET/);
  assert.match(idle, /end --confirm-drain-end/);
  assert.match(idle, /drain-state must be canonical and may not traverse symlinks/);
  assert.match(idle, /systemctl mask "\$service"/);
  assert.match(idle, /systemctl unmask "\$service"/);
  assert.match(idle, /all declared services were re-masked/);
  assert.match(idle, /Trim failed\. Keep services masked/);
  assert.match(idle, /unknown service unit/);
  assert.match(idle, /service is not explicitly inactive/);
  assert.match(idle, /Runner\.Worker or Runner\.Listener/);
  assert.match(idle, /fstrim -v/);
  assert.doesNotMatch(hook + installer + idle, /Station/i);
});

test('maintenance drain validates recorded identities and re-masks every service after a partial unmask failure', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'kontour-runner-drain-'));
  const bin = join(fixtureRoot, 'bin');
  const mountRoot = join(fixtureRoot, 'mount');
  const sourcePath = join(mountRoot, 'work');
  const targetPath = join(fixtureRoot, 'target');
  const stateRoot = join(fixtureRoot, 'state');
  const drainState = join(fixtureRoot, 'drain.state');
  await mkdir(bin, { recursive: true });
  await mkdir(sourcePath, { recursive: true });
  await mkdir(targetPath, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  const writeExecutable = async (name, contents) => {
    const path = join(bin, name);
    await writeFile(path, contents);
    await chmod(path, 0o755);
  };
  await writeExecutable('realpath', '#!/usr/bin/env bash\n[[ $1 == -m || $1 == -e ]] && shift\n[[ $1 == -- ]] && shift\nprintf "%s\\n" "$1"\n');
  await writeExecutable('systemctl', `#!/usr/bin/env bash
set -euo pipefail
service="\${!#}"
case "$1" in
  show)
    case "$2" in
      --property=LoadState) printf 'loaded\\n' ;;
      --property=UnitFileState) [[ -f "$FAKE_STATE/masked-$service" ]] && printf 'masked\\n' || printf 'disabled\\n' ;;
    esac
    ;;
  is-active) printf 'inactive\\n'; exit 3 ;;
  mask) : > "$FAKE_STATE/masked-$service" ;;
  unmask) [[ "\${FAKE_UNMASK_FAIL_SERVICE:-}" != "$service" ]] || exit 1; rm -f "$FAKE_STATE/masked-$service" ;;
esac
`);
  await writeExecutable('findmnt', '#!/usr/bin/env bash\ncase "$2" in UUID) printf "%s\\n" "$FAKE_UUID" ;; FSROOT) printf "/work\\n" ;; esac\n');
  await writeExecutable('mountpoint', '#!/usr/bin/env bash\nexit 0\n');
  await writeExecutable('pgrep', '#!/usr/bin/env bash\nexit 1\n');
  await writeExecutable('fstrim', '#!/usr/bin/env bash\nprintf "trimmed %s\\n" "$*"\n');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: stateRoot, FAKE_UUID: '11111111-1111-1111-1111-111111111111' };

  try {
    await execFile(maintenance, ['begin', '--confirm-idle', '--uuid', env.FAKE_UUID, '--mount-root', mountRoot, '--bind', `${sourcePath}:${targetPath}`, '--drain-state', drainState, '--service', 'fixture-a.service', '--service', 'fixture-b.service'], { env });
    await assert.doesNotReject(() => accessFile(drainState));
    await assert.doesNotReject(() => accessFile(join(stateRoot, 'masked-fixture-a.service')));
    await assert.doesNotReject(() => accessFile(join(stateRoot, 'masked-fixture-b.service')));

    let failure;
    try {
      await execFile(maintenance, ['end', '--confirm-drain-end', '--drain-state', drainState], { env: { ...env, FAKE_UNMASK_FAIL_SERVICE: 'fixture-b.service' } });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'end must fail if persistent masks cannot be removed');
    assert.match(failure.stderr, /all declared services were re-masked/);
    await assert.doesNotReject(() => accessFile(drainState));
    await assert.doesNotReject(() => accessFile(join(stateRoot, 'masked-fixture-a.service')));
    await assert.doesNotReject(() => accessFile(join(stateRoot, 'masked-fixture-b.service')));

    await execFile(maintenance, ['end', '--confirm-drain-end', '--drain-state', drainState], { env });
    await assert.rejects(() => accessFile(drainState));
    await assert.rejects(() => accessFile(join(stateRoot, 'masked-fixture-a.service')));
    await assert.rejects(() => accessFile(join(stateRoot, 'masked-fixture-b.service')));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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
  assert.match(script, /--no-start-services/);
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
  assert.match(text, /canonical, non-reparse `ProgramData` ancestry/i);
  assert.match(text, /SHA-256/i);
  assert.match(text, /no execution-time limit/i);
  assert.match(text, /keeps WSL alive with a blocking/i);
  assert.match(text, /Stop-ScheduledTask -TaskName \$taskName/);
  assert.match(text, /Task did not stop; do not detach the VHD/i);
  assert.match(text, /UUID and filesystem root/i);
  assert.match(text, /manual, destructive confirmation step/i);
  assert.match(text, /stop the runner\s+services/i);
  assert.match(text, /Storage lifecycle hooks/);
  assert.match(text, /ACTIONS_RUNNER_HOOK_JOB_STARTED/);
  assert.match(text, /does not delete workspaces,\s*dependency caches,[\s\S]*semantic receipts/i);
  assert.match(text, /persisted drain/i);
  assert.match(text, /confirm-drain-end/i);
});
