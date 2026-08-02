# Windows + WSL runner workspace on an SSD-backed VHD

This kit moves mutable WSL runner work trees off a slow WSL distribution VHD
without coupling the setup to any repository, host name, runner name, or disk
letter. It does not change a live host by itself.

## Safety model

- The Windows script requires elevation, creates a VHD only when its path is
  absent, and refuses to overwrite an existing file.
- Windows attaches the VHD through `wsl.exe --mount --vhd --bare`, never via a
  Windows drive mount and never initializes or formats its disk. Format it once
  from the selected WSL distribution after confirming the disk identity.
- The WSL bootstrap mounts by the recorded ext4 UUID, not a volatile `/dev/sdX`
  path. It refuses an occupied mount point, a missing UUID, non-canonical or
  symlink-traversing bind paths, a source outside the recorded filesystem, or
  a target mounted with a different UUID and filesystem root.
- Install the bootstrap as a systemd prerequisite for runner services so the
  bind mounts exist before work begins. It starts services only after every
  mount succeeds.
- The Windows task runs only as the Windows user that owns the WSL
  distribution. Its protected copy is installed under `ProgramData`, and it
  keeps a blocking WSL process open after bootstrapping so the distribution
  remains available for the runner services.
- Every runner listener starts only after a bounded same-filesystem 4 KiB
  write+fsync probe succeeds. A failed or timed-out probe persists an incident
  marker outside the VHD and masks its runner services until an operator runs a
  verified clear command.

## One-time setup

From elevated Windows PowerShell, choose an SSD-backed absolute VHD path and
capacity:

```powershell
.\runner-host\windows-wsl-runner-workspace.ps1 -Mode Provision `
  -VhdPath 'C:\RunnerStorage\runner-work.vhdx' -VhdSizeGB 48 -DistroName 'Ubuntu'
```

From the chosen WSL distribution, identify the newly attached disk with
`lsblk --fs`, then initialize that exact empty disk. This is intentionally a
manual, destructive confirmation step:

```sh
sudo mkfs.ext4 /dev/<new-disk>
sudo blkid /dev/<new-disk> # record the UUID
```

Install both `bootstrap-wsl-runner-workspace.sh` and
`runner-storage-health.sh` on the distribution (for example under
`/usr/local/sbin`) and make the bootstrap systemd unit run before the runner
services. These are privileged task entrypoints: their files and every parent
directory through `/` must be root-owned and must not be group- or
world-writable. Install them from a trusted checkout, then verify the exact
paths before registering the Windows task:

```sh
sudo install -o root -g root -m 0755 runner-host/bootstrap-wsl-runner-workspace.sh /usr/local/sbin/bootstrap-wsl-runner-workspace.sh
sudo install -o root -g root -m 0755 runner-host/runner-storage-health.sh /usr/local/sbin/runner-storage-health.sh
namei -l /usr/local/sbin/bootstrap-wsl-runner-workspace.sh
namei -l /usr/local/sbin/runner-storage-health.sh
```

The installer rejects links, non-regular files, noncanonical paths, and any
group- or world-writable WSL script ancestry. Supply the UUID, a mount root,
and one binding for every runner work path. For example, the sources are
directories inside the VHD mount and the targets are existing runner work
paths:

```sh
sudo /usr/local/sbin/bootstrap-wsl-runner-workspace.sh \
  --uuid <ext4-uuid> --mount-root /mnt/runner-work \
  --bind /mnt/runner-work/work:/var/lib/example-runner/work \
  --bind /mnt/runner-work/work-2:/var/lib/example-runner/work-2 \
  --health-script /usr/local/sbin/runner-storage-health.sh \
  --health-incident-path /var/lib/kontour-runner-storage/runner-work.incident \
  --health-timeout-seconds 30 \
  --service example-runner.service
```

Create the Windows startup task only after the VHD has been formatted and the
WSL bootstrap has been tested manually. The task takes structured WSL paths
and arguments; it invokes the verified scripts directly with `wsl.exe --exec`,
never through `bash -lc` or an opaque command string. The watcher is the
blocking WSL process; it checks the same filesystem every 60 seconds and, if
it cannot start or exits unexpectedly, the protected task invokes the trusted
health script's stop-and-mask containment command:

```powershell
.\runner-host\windows-wsl-runner-workspace.ps1 -Mode InstallBootTask `
  -VhdPath 'C:\RunnerStorage\runner-work.vhdx' -DistroName 'Ubuntu' `
  -WslWindowsUser 'EXAMPLE\runner-owner' `
  -WslBootstrapScript '/usr/local/sbin/bootstrap-wsl-runner-workspace.sh' `
  -WslHealthScript '/usr/local/sbin/runner-storage-health.sh' `
  -WslUuid '<ext4-uuid>' -WslMountRoot '/mnt/runner-work' `
  -WslBind @('/mnt/runner-work/work:/var/lib/example-runner/work', '/mnt/runner-work/work-2:/var/lib/example-runner/work-2') `
  -WslHealthIncidentPath '/var/lib/kontour-runner-storage/runner-work.incident' `
  -WslHealthTimeoutSeconds 30 -WslHealthIntervalSeconds 60 `
  -RunnerService @('example-runner.service', 'example-runner-2.service')
```

Run that command elevated as the WSL-owning Windows user. WSL distribution
registrations are per Windows user, so the installer checks that this user can
enumerate `DistroName` before it creates the task. The task runs as that
interactive user at highest run level and has both boot and logon triggers; it
cannot run headlessly as `SYSTEM` or another Windows user. The installer copies
the entrypoint through a canonical, non-reparse `ProgramData` ancestry, hardens
each new parent top-down, and verifies the protected file identity and SHA-256
before registering it, so the highest task never points at this checkout. The
task has no execution-time limit, keeps WSL alive with a blocking
process, retries failures three times at one-minute intervals, and ignores a
second simultaneous trigger. The logon trigger is authoritative: a boot trigger
only runs when Windows has a usable token for that user. If boot and logon race,
an already attached VHD is accepted only after the UUID bootstrap validates its
filesystem and bind identity; otherwise the task fails and leaves services
stopped.

The task attaches the VHD through WSL, invokes verified root-owned Linux
scripts directly as root, then the Linux bootstrap finds the ext4 volume by
UUID, binds work paths, and starts services. Existing bind mounts are idempotent only when their UUID
and filesystem root match the declared source. To recover, stop the runner
services, unmount the bind targets and mount root in WSL, then detach the VHD
in Windows only after no process has an open file on it. Keep the VHD file: it
is the recoverable workspace state.

The installer serializes the WSL configuration once as validated structured
data for the protected scheduled-task entrypoint, so every declared bind and
runner service is preserved across task registration. If the health watcher
cannot start or returns, its emergency `contain` invocation first verifies
`systemctl` stop-and-mask containment; recording the incident marker and
storage identity is best-effort so an unavailable VHD mount cannot prevent
containment.

## Storage lifecycle hooks

Self-hosted runners do not automatically enforce useful workspace headroom.
Install `runner-storage-hook.sh` as the documented Actions Runner job hooks:
the `preflight` hook checks the workspace filesystem and a separately supplied
host-headroom path before job steps run. The `completed` hook records cheap
filesystem capacity from `df`, rather than scanning the whole workspace; it
locks and bounds the shared log safely. It does not delete workspaces,
dependency caches, or semantic receipts.

Generate wrappers for each runner root rather than sharing a mutable wrapper:

```sh
sudo ./runner-host/install-runner-storage-hooks.sh \
  --hook-script /usr/local/sbin/runner-storage-hook.sh \
  --workspace-root /var/lib/example-runner/work \
  --headroom-path /mnt/runner-work \
  --minimum-free-gb 20 --minimum-free-percent 15 \
  --usage-log /var/log/example-runner/storage-usage.log \
  --runner-service-user example-runner \
  --runner-root /var/lib/example-runner-a \
  --runner-root /var/lib/example-runner-b
```

It prints `ACTIONS_RUNNER_HOOK_JOB_STARTED` and
`ACTIONS_RUNNER_HOOK_JOB_COMPLETED` for each root. Put those values in that
runner's systemd service environment, then restart the service during a
maintenance window. The installer requires the runner service identity,
provisions a dedicated new log directory with that identity, and verifies that
the service user can write both the directory and log before generating hooks.
For an existing log directory or log it validates writability without changing
ownership. It intentionally does not edit or restart a runner service.

## Storage health incident recovery

An incident marker means the automatic task and bootstrap will keep runners
masked; do not delete it or start services manually. First use the maintenance
drain described below, detach the VHD, and run an offline `fsck.ext4 -f` on the
exact VHD filesystem from a trusted Linux recovery environment. Reattach the
VHD, restore its UUID mount and bindings with `--no-start-services`, and run
the maintenance `end` command to verify the recorded bind identities. Then run
a verified clear. It performs another write+fsync probe before unmasking, and
it does not start services:

```sh
sudo /usr/local/sbin/runner-storage-health.sh clear \
  --probe-path /mnt/runner-work \
  --incident-path /var/lib/kontour-runner-storage/runner-work.incident \
  --timeout-seconds 30 --service example-runner.service
```

Only after that command succeeds may you re-enable and start the Windows task.
If its probe still fails or times out, it recreates/retains the marker and
keeps services masked.

## Recommended topology

Use one SSD-backed VHD per runner listener. Give each invocation its own VHD
path, UUID, mount root, incident path, service name, and scheduled task name.
This isolates a storage incident and offline repair to one runner. The kit also
supports multiple independent invocations on a host; it does not migrate an
existing shared VHD automatically.

If a runner creates disposable per-job scratch data outside its normal work
path, opt into cleanup only with both `--ephemeral-root` and `--job-id`. The
completed hook removes only the direct child named by that simple job ID when
it contains the `.kontour-ephemeral-job` marker. Do not point this at a normal
runner work directory, cache, receipt store, or VHD mount root.

For capacity reclamation, do not schedule deletion. During a maintenance
window, first disable the Windows keepalive task so it cannot re-run the UUID
bootstrap, then stop every runner service and confirm there is no
`Runner.Worker` or `Runner.Listener`. Begin a persisted drain:

```powershell
$taskName = 'Kontour WSL runner workspace VHD attach'
Disable-ScheduledTask -TaskName $taskName
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(30)
do {
  $state = (Get-ScheduledTask -TaskName $taskName).State
  if ($state -ne 'Running') { break }
  Start-Sleep -Seconds 1
} while ((Get-Date) -lt $deadline)
if ($state -eq 'Running') { throw "Task did not stop; do not detach the VHD: $taskName" }
```

```sh
sudo ./runner-host/idle-runner-storage-maintenance.sh \
  begin --confirm-idle --uuid <ext4-uuid> --mount-root /mnt/runner-work \
  --bind /mnt/runner-work/work:/var/lib/example-runner/work \
  --bind /mnt/runner-work/work-2:/var/lib/example-runner/work-2 \
  --drain-state /var/lib/example-runner/vhd-maintenance.drain \
  --service example-runner-a.service --service example-runner-b.service
```

It records the UUID and UUID+filesystem-root identity of every bind, rejects
unknown, externally masked, or non-inactive service units, masks the declared
units persistently, rechecks both processes, and only then issues `fstrim`.
Only after the task stop poll succeeds may you unmount the bind targets and
mount root in WSL, then detach and compact the VHD. Keep the drain state through
reattach. Restore the UUID mount and bindings with the normal bootstrap command
plus `--no-start-services` (the persistent masks deliberately prevent it from
starting runners during the drain). To compact the dynamic VHD, retain a backup
or copy first, then run from elevated Windows PowerShell:

```powershell
.\runner-host\windows-wsl-runner-workspace.ps1 -Mode Compact `
  -VhdPath 'C:\RunnerStorage\runner-work.vhdx' -ConfirmDrainActive -ConfirmDetached
```

`Compact` requires the operator to confirm that WSL already detached the VHD;
it does not stop services, detach storage, or delete files. After the bootstrap
has restored the workspace mount, end the drain to remove the persisted masks:

```sh
sudo ./runner-host/idle-runner-storage-maintenance.sh \
  end --confirm-drain-end \
  --drain-state /var/lib/example-runner/vhd-maintenance.drain
```

`end` validates the recorded UUID and bind identities before removing a mask.
If any unmask fails, it re-masks every declared service, exits nonzero, keeps
the drain state, and prints the exact recovery command. Re-enable the Windows
task only after `end` succeeds:

```powershell
Enable-ScheduledTask -TaskName 'Kontour WSL runner workspace VHD attach'
Start-ScheduledTask -TaskName 'Kontour WSL runner workspace VHD attach'
```
