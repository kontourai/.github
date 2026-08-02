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
const storageHealth = fileURLToPath(new URL('../runner-host/runner-storage-health.sh', import.meta.url));
const hookInstaller = fileURLToPath(new URL('../runner-host/install-runner-storage-hooks.sh', import.meta.url));
const maintenance = fileURLToPath(new URL('../runner-host/idle-runner-storage-maintenance.sh', import.meta.url));
const dockerMaintenance = fileURLToPath(new URL('../runner-host/idle-runner-docker-maintenance.sh', import.meta.url));
const dockerMaintenanceInstaller = fileURLToPath(new URL('../runner-host/install-idle-runner-docker-maintenance.sh', import.meta.url));
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
  assert.match(script, /WslBootstrapScript/);
  assert.match(script, /WslHealthScript/);
  assert.match(script, /WslUuid/);
  assert.match(script, /WslMountRoot/);
  assert.match(script, /WslBind/);
  assert.match(script, /RunnerService/);
  assert.match(script, /WslConfigurationBase64/);
  assert.match(script, /ConvertTo-Json -Compress/);
  assert.match(script, /ConvertFrom-Json/);
  assert.match(script, /Assert-WslCanonicalRootOwnedScript/);
  assert.match(script, /\/usr\/bin\/readlink -f/);
  assert.match(script, /\/usr\/bin\/stat/);
  assert.match(script, /\$readlinkExitCode = \$LASTEXITCODE[\s\S]*\$resolvedOutput \| Select-Object/);
  assert.match(script, /\$statExitCode = \$LASTEXITCODE[\s\S]*\$metadataOutput \| Select-Object/);
  assert.doesNotMatch(script, /wsl\.exe[^\n]+\| Select-Object[^\n]+[\s\S]{0,120}\$LASTEXITCODE/);
  assert.match(script, /root-owned and not group- or world-writable/);
  assert.match(script, /--exec/);
  assert.doesNotMatch(script, /bash -lc/);
  assert.match(script, /'AttachAndBootstrap'/);
  assert.match(script, /AttachBootstrapAndKeepAlive/);
  assert.match(script, /Attach-WorkspaceVhd -AllowAlreadyAttached/);
  assert.match(script, /UUID bootstrap validated it before services were started/);
  assert.match(script, /Invoke-WslContainment/);
  assert.match(script, /trusted stop-and-mask containment/);
  assert.match(script, /WSL health watcher returned unexpectedly[\s\S]*exit code \$watchExitCode/);
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

test('scheduled task structured configuration preserves every bind and runner service', async () => {
  const script = await readFile(windowsScript, 'utf8');
  const configuration = {
    WslBootstrapScript: '/usr/local/sbin/bootstrap-wsl-runner-workspace.sh',
    WslHealthScript: '/usr/local/sbin/runner-storage-health.sh',
    WslUuid: '11111111-1111-1111-1111-111111111111',
    WslMountRoot: '/mnt/runner-work',
    WslBind: [
      '/mnt/runner-work/a:/var/lib/runner-a/work',
      '/mnt/runner-work/b:/var/lib/runner-b/work'
    ],
    WslHealthIncidentPath: '/var/lib/kontour-runner-storage/runner.incident',
    WslHealthTimeoutSeconds: 30,
    WslHealthIntervalSeconds: 60,
    RunnerService: ['runner-a.service', 'runner-b.service']
  };
  const encoded = Buffer.from(JSON.stringify(configuration), 'utf8').toString('base64');
  const scheduledCommand = `& protected.ps1 -Mode AttachBootstrapAndKeepAlive -WslConfigurationBase64 '${encoded}'`;
  const encodedArgument = scheduledCommand.match(/-WslConfigurationBase64 '([^']+)'/)?.[1];
  const restored = JSON.parse(Buffer.from(encodedArgument, 'base64').toString('utf8'));

  assert.deepEqual(restored.WslBind, configuration.WslBind);
  assert.deepEqual(restored.RunnerService, configuration.RunnerService);
  assert.match(script, /WslBind = @\(\$WslBind\)/);
  assert.match(script, /RunnerService = @\(\$RunnerService\)/);
  assert.match(script, /-WslConfigurationBase64 \$quotedConfiguration/);
  assert.doesNotMatch(script, /foreach \(\$binding in \$WslBind\) \{ \$commandParts/);
  assert.doesNotMatch(script, /foreach \(\$service in \$RunnerService\) \{ \$commandParts/);
});

test('storage health probe fails closed and clears only after a passing recovery probe', async () => {
  const healthScript = await readFile(storageHealth, 'utf8');
  assert.match(healthScript, /timeout_seconds=30/);
  assert.match(healthScript, /timeout --foreground --kill-after=2s/);
  assert.match(healthScript, /conv=fsync/);
  assert.match(healthScript, /Runner storage incident marker exists/);
  assert.match(healthScript, /contain_services/);
  assert.match(healthScript, /require_containment/);
  assert.match(healthScript, /can_record_containment_incident/);
  assert.match(healthScript, /is-active --quiet/);
  assert.match(healthScript, /UnitFileState/);
  assert.match(healthScript, /health incident marker does not exactly match/);
  assert.match(healthScript, /Storage recovery probe passed and incident marker cleared/);
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'kontour-storage-health-'));
  const bin = join(fixtureRoot, 'bin');
  const probePath = join(fixtureRoot, 'probe');
  const otherProbePath = join(fixtureRoot, 'other-probe');
  const stateRoot = join(fixtureRoot, 'state');
  const incidentPath = join(fixtureRoot, 'incidents', 'runner.incident');
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(probePath, { recursive: true }), mkdir(otherProbePath, { recursive: true }), mkdir(stateRoot, { recursive: true })]);
  const writeExecutable = async (name, contents) => {
    const path = join(bin, name);
    await writeFile(path, contents);
    await chmod(path, 0o755);
  };
  await writeExecutable('realpath', '#!/usr/bin/env bash\n[[ $1 == -m || $1 == -e ]] && shift\n[[ $1 == -- ]] && shift\nprintf "%s\\n" "$1"\n');
  await writeExecutable('findmnt', '#!/usr/bin/env bash\ncase "$2" in UUID) printf "%s\\n" "${FAKE_HEALTH_UUID:-22222222-2222-2222-2222-222222222222}" ;; FSROOT) printf "%s\\n" "${FAKE_HEALTH_FSROOT:-/}" ;; esac\n');
  await writeExecutable('timeout', '#!/usr/bin/env bash\ncase "${FAKE_HEALTH_RESULT:-healthy}" in healthy) exit 0 ;; timeout) exit 124 ;; *) exit 1 ;; esac\n');
  await writeExecutable('flock', '#!/usr/bin/env bash\nexit 0\n');
  await writeExecutable('systemctl', `#!/usr/bin/env bash
set -euo pipefail
service="\${!#}"
case "$1" in
  stop)
    [[ "\${FAKE_HEALTH_STOP_FAIL_SERVICE:-}" != "$service" ]] || exit 1
    : > "$FAKE_HEALTH_STATE/stopped-$service"
    ;;
  is-active)
    [[ "\${FAKE_HEALTH_ACTIVE_SERVICE:-}" == "$service" ]] && exit 0
    exit 3
    ;;
  mask)
    [[ "\${FAKE_HEALTH_MASK_FAIL_SERVICE:-}" != "$service" ]] || exit 1
    : > "$FAKE_HEALTH_STATE/masked-$service"
    ;;
  show)
    [[ -f "$FAKE_HEALTH_STATE/masked-$service" ]] && printf 'masked\\n' || printf 'disabled\\n'
    ;;
  unmask) rm -f "$FAKE_HEALTH_STATE/masked-$service" ;;
esac
`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_HEALTH_STATE: stateRoot };
  const args = ['--probe-path', probePath, '--incident-path', incidentPath, '--timeout-seconds', '30', '--maintenance-lock', join(fixtureRoot, 'maintenance.lock'), '--service', 'fixture.service'];

  try {
    await execFile(storageHealth, ['probe', ...args], { env: { ...env, FAKE_HEALTH_RESULT: 'healthy' } });
    await assert.rejects(() => accessFile(incidentPath));

    await assert.rejects(() => execFile(storageHealth, ['probe', ...args], { env: { ...env, FAKE_HEALTH_RESULT: 'timeout' } }));
    const incident = await readFile(incidentPath, 'utf8');
    assert.match(incident, /reason=timeout/);
    assert.match(incident, new RegExp(`probe_path=${probePath}`));
    assert.match(incident, /filesystem_uuid=22222222-2222-2222-2222-222222222222/);
    await assert.doesNotReject(() => accessFile(join(stateRoot, 'stopped-fixture.service')));
    await assert.doesNotReject(() => accessFile(join(stateRoot, 'masked-fixture.service')));

    let markerRefusal;
    try {
      await execFile(storageHealth, ['probe', ...args], { env: { ...env, FAKE_HEALTH_RESULT: 'healthy' } });
    } catch (error) {
      markerRefusal = error;
    }
    assert.ok(markerRefusal, 'a persisted incident must refuse an otherwise healthy automatic probe');
    assert.match(markerRefusal.stderr, /Refusing automatic restart/);

    await assert.rejects(() => execFile(storageHealth, ['clear', ...args], { env: { ...env, FAKE_HEALTH_RESULT: 'timeout' } }));
    await assert.doesNotReject(() => accessFile(incidentPath));

    await execFile(storageHealth, ['clear', ...args], { env: { ...env, FAKE_HEALTH_RESULT: 'healthy' } });
    await assert.rejects(() => accessFile(incidentPath));
    await assert.rejects(() => accessFile(join(stateRoot, 'masked-fixture.service')));

    await assert.rejects(
      () => execFile(storageHealth, ['probe', ...args], {
        env: { ...env, FAKE_HEALTH_RESULT: 'timeout', FAKE_HEALTH_MASK_FAIL_SERVICE: 'fixture.service' }
      }),
      /containment is incomplete/
    );
    await assert.doesNotReject(() => accessFile(incidentPath));
    await assert.doesNotReject(() => accessFile(join(stateRoot, 'stopped-fixture.service')));
    await assert.rejects(() => accessFile(join(stateRoot, 'masked-fixture.service')));

    const mismatchedProbeArgs = [...args];
    mismatchedProbeArgs[1] = otherProbePath;
    await assert.rejects(
      () => execFile(storageHealth, ['clear', ...mismatchedProbeArgs], { env: { ...env, FAKE_HEALTH_RESULT: 'healthy' } }),
      /probe path does not match/
    );
    await assert.doesNotReject(() => accessFile(incidentPath));

    await assert.rejects(
      () => execFile(storageHealth, ['clear', ...args], {
        env: { ...env, FAKE_HEALTH_RESULT: 'healthy', FAKE_HEALTH_UUID: '33333333-3333-3333-3333-333333333333' }
      }),
      /filesystem identity does not match/
    );
    await assert.doesNotReject(() => accessFile(incidentPath));
    await execFile(storageHealth, ['clear', ...args], { env: { ...env, FAKE_HEALTH_RESULT: 'healthy' } });
    await assert.rejects(() => accessFile(incidentPath));

    await assert.rejects(
      () => execFile(storageHealth, ['probe', ...args], {
        env: { ...env, FAKE_HEALTH_RESULT: 'timeout', FAKE_HEALTH_STOP_FAIL_SERVICE: 'fixture.service' }
      }),
      /containment is incomplete/
    );
    await assert.doesNotReject(() => accessFile(incidentPath));
    await assert.doesNotReject(() => accessFile(join(stateRoot, 'masked-fixture.service')));
    const mismatchedServiceArgs = [...args.slice(0, -1), 'other.service'];
    await assert.rejects(
      () => execFile(storageHealth, ['clear', ...mismatchedServiceArgs], { env: { ...env, FAKE_HEALTH_RESULT: 'healthy' } }),
      /services do not match/
    );
    await assert.doesNotReject(() => accessFile(incidentPath));
    await execFile(storageHealth, ['clear', ...args], { env: { ...env, FAKE_HEALTH_RESULT: 'healthy' } });
    await assert.rejects(() => accessFile(incidentPath));

    await mkdir(incidentPath);
    await assert.rejects(
      () => execFile(storageHealth, ['probe', ...args], { env: { ...env, FAKE_HEALTH_RESULT: 'healthy' } }),
      /malformed or non-regular/
    );
    await assert.doesNotReject(() => accessFile(join(stateRoot, 'masked-fixture.service')));
    await rm(incidentPath, { recursive: true });
    await writeFile(incidentPath, 'not-a-health-marker\n');
    await assert.rejects(
      () => execFile(storageHealth, ['clear', ...args], { env: { ...env, FAKE_HEALTH_RESULT: 'healthy' } }),
      /does not exactly match/
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('Docker cache maintenance is bounded, idle-only, and coordinated with storage probes', async () => {
  const dockerScript = await readFile(dockerMaintenance, 'utf8');
  const installer = await readFile(dockerMaintenanceInstaller, 'utf8');
  const healthScript = await readFile(storageHealth, 'utf8');
  assert.match(dockerScript, /flock -n -x 9/);
  assert.match(healthScript, /flock -s 8/);
  assert.match(dockerScript, /docker builder prune --force --reserved-space "\$reserved_space"/);
  assert.doesNotMatch(dockerScript, /docker (image|system|volume|container) prune/);
  assert.match(installer, /OnCalendar=\$on_calendar/);
  assert.match(installer, /RandomizedDelaySec=10min/);
  assert.match(installer, /systemctl enable --now "\$\{unit_name\}\.timer"/);
  assert.doesNotMatch(dockerScript + installer, /Station/i);

  const fixtureRoot = await mkdtemp(join(tmpdir(), 'kontour-docker-maintenance-'));
  const bin = join(fixtureRoot, 'bin');
  const headroom = join(fixtureRoot, 'headroom');
  const stateRoot = join(fixtureRoot, 'state');
  const lockPath = join(fixtureRoot, 'host.lock');
  const receiptPath = join(fixtureRoot, 'receipt');
  const logPath = join(fixtureRoot, 'docker.log');
  await Promise.all([mkdir(bin), mkdir(headroom), mkdir(stateRoot)]);
  const writeExecutable = async (name, contents) => {
    const path = join(bin, name);
    await writeFile(path, contents);
    await chmod(path, 0o755);
  };
  await writeExecutable('systemctl', `#!/usr/bin/env bash
case "$1" in
  show) printf '%s\n' "\${FAKE_LOAD_STATE:-loaded}" ;;
  is-active) printf '%s\n' "\${FAKE_ACTIVE_STATE:-inactive}"; [[ "\${FAKE_ACTIVE_STATE:-inactive}" == active ]] && exit 0 || exit 3 ;;
esac
`);
  await writeExecutable('pgrep', `#!/usr/bin/env bash
[[ "\${FAKE_RUNNER_PROCESS:-no}" == yes || "\${FAKE_BUILD_CLIENT:-no}" == yes ]]
`);
  await writeExecutable('docker', `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DOCKER_CALLS"
if [[ "$1" == ps ]]; then
  [[ "\${FAKE_DOCKER_PS_FAIL:-no}" == yes ]] && exit 1
  [[ "\${FAKE_RUNNING_CONTAINER:-no}" == yes ]] && printf 'container-id\n'
  exit 0
fi
if [[ "$1 $2" == 'builder prune' ]]; then
  for line in {1..250}; do printf 'docker-output-%s\n' "$line"; done
  exit "\${FAKE_PRUNE_EXIT:-0}"
fi
exit 2
`);
  await writeExecutable('df', `#!/usr/bin/env bash
printf 'Filesystem 1-blocks Used Available Use%% Mounted on\n'
printf 'fixture 107374182400 96636764160 1073741824 90%% %s\n' "$FAKE_HEADROOM"
`);
  await writeExecutable('flock', '#!/usr/bin/env bash\n[[ "${FAKE_FLOCK_BUSY:-no}" == yes ]] && exit 1\nexit 0\n');

  const dockerCalls = join(stateRoot, 'docker-calls');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_DOCKER_CALLS: dockerCalls,
    FAKE_HEADROOM: headroom
  };
  const commonArgs = [
    '--headroom-path', headroom,
    '--service', 'fixture.service',
    '--minimum-free-gb', '20',
    '--minimum-free-percent', '15',
    '--reserved-space', '20GB',
    '--maintenance-lock', lockPath,
    '--receipt-path', receiptPath,
    '--log-path', logPath,
    '--log-lines', '20'
  ];

  try {
    const dryRun = await execFile(dockerMaintenance, ['dry-run', ...commonArgs], { env });
    assert.match(dryRun.stdout, /result=would_prune/);
    assert.doesNotMatch(await readFile(dockerCalls, 'utf8'), /builder prune/);

    const busy = await execFile(dockerMaintenance, ['prune', '--confirm-idle', ...commonArgs], {
      env: { ...env, FAKE_ACTIVE_STATE: 'active' }
    });
    assert.match(busy.stdout, /result=skipped_busy reason=service_not_inactive:fixture\.service:active/);
    assert.doesNotMatch(await readFile(dockerCalls, 'utf8'), /builder prune/);

    const dockerUnavailable = await execFile(dockerMaintenance, ['prune', '--confirm-idle', ...commonArgs], {
      env: { ...env, FAKE_DOCKER_PS_FAIL: 'yes' }
    });
    assert.match(dockerUnavailable.stdout, /result=skipped_busy reason=docker_ps_failed/);
    assert.doesNotMatch(await readFile(dockerCalls, 'utf8'), /builder prune/);

    const pruned = await execFile(dockerMaintenance, ['prune', '--confirm-idle', ...commonArgs], { env });
    assert.match(pruned.stdout, /result=pruned/);
    assert.match(await readFile(dockerCalls, 'utf8'), /builder prune --force --reserved-space 20GB/);
    const receipt = await readFile(receiptPath, 'utf8');
    assert.match(receipt, /result=pruned/);
    assert.match(receipt, /before_free_bytes=1073741824/);
    assert.match(receipt, /after_free_bytes=1073741824/);
    const boundedLog = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(boundedLog.length, 20);
    assert.equal(boundedLog.at(-1), 'docker-output-250');

    const locked = await execFile(dockerMaintenance, ['status', ...commonArgs], { env: { ...env, FAKE_FLOCK_BUSY: 'yes' } });
    assert.match(locked.stdout, /result=skipped_busy reason=host_maintenance_lock/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('emergency containment stops and masks services without probe storage tooling', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'kontour-emergency-containment-'));
  const bin = join(fixtureRoot, 'bin');
  const stateRoot = join(fixtureRoot, 'state');
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(stateRoot, { recursive: true })]);
  const writeExecutable = async (name, contents) => {
    const path = join(bin, name);
    await writeFile(path, contents);
    await chmod(path, 0o755);
  };
  await writeExecutable('bash', '#!/bin/bash\nexec /bin/bash "$@"\n');
  await writeExecutable('systemctl', `#!/bin/bash
set -euo pipefail
service="\${!#}"
case "$1" in
  stop) : > "$FAKE_CONTAINMENT_STATE/stopped-$service" ;;
  is-active) exit 3 ;;
  mask) : > "$FAKE_CONTAINMENT_STATE/masked-$service" ;;
  show) printf 'masked\\n' ;;
esac
`);
  const env = { ...process.env, PATH: bin, FAKE_CONTAINMENT_STATE: stateRoot };

  try {
    const result = await execFile(storageHealth, [
      'contain',
      '--probe-path', '/unavailable-runner-vhd',
      '--incident-path', '/unavailable-runner-vhd/runner.incident',
      '--service', 'fixture-a.service',
      '--service', 'fixture-b.service'
    ], { env });
    assert.match(result.stderr, /services were stopped and masked, but emergency containment could not record a storage incident/);
    for (const service of ['fixture-a.service', 'fixture-b.service']) {
      await assert.doesNotReject(() => accessFile(join(stateRoot, `stopped-${service}`)));
      await assert.doesNotReject(() => accessFile(join(stateRoot, `masked-${service}`)));
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
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
  assert.match(idle, /rollback re-masking is incomplete/);
  assert.match(idle, /Do not re-enable the scheduled task or start runners/);
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
  mask)
    if [[ "\${FAKE_REMASK_FAIL_SERVICE:-}" == "$service" && -f "$FAKE_STATE/unmask-failed-\${FAKE_UNMASK_FAIL_SERVICE:-}" ]]; then
      exit 1
    fi
    : > "$FAKE_STATE/masked-$service"
    ;;
  unmask)
    if [[ "\${FAKE_UNMASK_FAIL_SERVICE:-}" == "$service" ]]; then
      : > "$FAKE_STATE/unmask-failed-$service"
      exit 1
    fi
    rm -f "$FAKE_STATE/masked-$service"
    ;;
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

    await execFile(maintenance, ['begin', '--confirm-idle', '--uuid', env.FAKE_UUID, '--mount-root', mountRoot, '--bind', `${sourcePath}:${targetPath}`, '--drain-state', drainState, '--service', 'fixture-a.service', '--service', 'fixture-b.service'], { env });
    let incompleteRecovery;
    try {
      await execFile(maintenance, ['end', '--confirm-drain-end', '--drain-state', drainState], {
        env: {
          ...env,
          FAKE_UNMASK_FAIL_SERVICE: 'fixture-b.service',
          FAKE_REMASK_FAIL_SERVICE: 'fixture-a.service'
        }
      });
    } catch (error) {
      incompleteRecovery = error;
    }
    assert.ok(incompleteRecovery, 'end must fail when rollback re-masking is incomplete');
    assert.match(incompleteRecovery.stderr, /rollback re-masking is incomplete/);
    assert.match(incompleteRecovery.stderr, /systemctl stop fixture-a\.service && systemctl mask fixture-a\.service/);
    await assert.doesNotReject(() => accessFile(drainState));
    await assert.rejects(() => accessFile(join(stateRoot, 'masked-fixture-a.service')));
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
  assert.match(script, /--health-script/);
  assert.match(script, /services require an executable health script/);
  assert.doesNotMatch(script, /Station/i);
});

test('runbook preserves the Windows-path and WSL-UUID recovery boundary', async () => {
  const text = await readFile(runbook, 'utf8');

  assert.match(text, /refuses to overwrite/i);
  assert.match(text, /mounts by the recorded ext4 UUID/i);
  assert.match(text, /wsl\.exe --mount --vhd --bare/);
  assert.match(text, /WslBootstrapScript/);
  assert.match(text, /WslHealthScript/);
  assert.match(text, /-WslBind @\('/);
  assert.match(text, /-RunnerService @\('/);
  assert.match(text, /serializes the WSL configuration once as validated structured\s+data/i);
  assert.match(text, /storage identity is best-effort/i);
  assert.match(text, /wsl\.exe --exec/);
  assert.match(text, /root-owned and must not be group- or\s+world-writable/i);
  assert.doesNotMatch(text, /WslBootstrapCommand/);
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
  assert.match(text, /offline `fsck\.ext4 -f`/i);
  assert.match(text, /one SSD-backed VHD per runner listener/i);
});
