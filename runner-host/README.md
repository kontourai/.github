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
  path. It refuses an occupied mount point, a missing UUID, an invalid bind, or
  a target already mounted from somewhere else.
- Install the bootstrap as a systemd prerequisite for runner services so the
  bind mounts exist before work begins. It starts services only after every
  mount succeeds.

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

Install `bootstrap-wsl-runner-workspace.sh` on the distribution and make its
systemd unit run before the runner services. Supply the UUID, a mount root, and
one binding for every runner work path. For example, the sources are directories
inside the VHD mount and the targets are existing runner work paths:

```sh
sudo /usr/local/sbin/bootstrap-wsl-runner-workspace.sh \
  --uuid <ext4-uuid> --mount-root /mnt/runner-work \
  --bind /mnt/runner-work/work:/var/lib/example-runner/work \
  --bind /mnt/runner-work/work-2:/var/lib/example-runner/work-2 \
  --service example-runner.service
```

Create the Windows startup task only after the VHD has been formatted and the
WSL bootstrap has been tested manually. The task needs the exact single-line
bootstrap command, including the UUID and every bind/service mapping:

```powershell
$bootstrap = '/usr/local/sbin/bootstrap-wsl-runner-workspace.sh --uuid <ext4-uuid> --mount-root /mnt/runner-work --bind /mnt/runner-work/work:/var/lib/example-runner/work --bind /mnt/runner-work/work-2:/var/lib/example-runner/work-2 --service example-runner.service'
.\runner-host\windows-wsl-runner-workspace.ps1 -Mode InstallBootTask `
  -VhdPath 'C:\RunnerStorage\runner-work.vhdx' -DistroName 'Ubuntu' `
  -WslBootstrapCommand $bootstrap
```

The boot task attaches the VHD through WSL, invokes the selected distribution
as root, then the Linux bootstrap finds the ext4 volume by UUID, binds work
paths, and starts services. A bootstrap failure fails the task and leaves
services stopped. To recover, stop the runner services, unmount the bind targets
and mount root in WSL, then detach the VHD in Windows only after no process has
an open file on it. Keep the VHD file: it is the recoverable workspace state.

## Storage lifecycle hooks

Self-hosted runners do not automatically enforce useful workspace headroom.
Install `runner-storage-hook.sh` as the documented Actions Runner job hooks:
the `preflight` hook checks the workspace filesystem and a separately supplied
host-headroom path before job steps run. The `completed` hook appends one
bounded usage record; it does not delete workspaces, dependency caches, or
semantic receipts.

Generate wrappers for each runner root rather than sharing a mutable wrapper:

```sh
sudo ./runner-host/install-runner-storage-hooks.sh \
  --hook-script /usr/local/sbin/runner-storage-hook.sh \
  --workspace-root /var/lib/example-runner/work \
  --headroom-path /mnt/runner-work \
  --minimum-free-gb 20 --minimum-free-percent 15 \
  --usage-log /var/log/example-runner/storage-usage.log \
  --runner-root /var/lib/example-runner-a \
  --runner-root /var/lib/example-runner-b
```

It prints `ACTIONS_RUNNER_HOOK_JOB_STARTED` and
`ACTIONS_RUNNER_HOOK_JOB_COMPLETED` for each root. Put those values in that
runner's systemd service environment, then restart the service during a
maintenance window. The installer intentionally does not edit or restart a
runner service.

If a runner creates disposable per-job scratch data outside its normal work
path, opt into cleanup only with both `--ephemeral-root` and `--job-id`. The
completed hook removes only the direct child named by that simple job ID when
it contains the `.kontour-ephemeral-job` marker. Do not point this at a normal
runner work directory, cache, receipt store, or VHD mount root.

For capacity reclamation, do not schedule deletion. During a maintenance
window, stop every runner service, confirm there is no `Runner.Worker`, then
run the idle-only trim command:

```sh
sudo ./runner-host/idle-runner-storage-maintenance.sh \
  --confirm-idle --mount-root /mnt/runner-work \
  --service example-runner-a.service --service example-runner-b.service
```

It refuses active services or workers and only issues `fstrim`. To compact the
dynamic VHD, repeat the idle checks, unmount and detach it, retain a backup or
copy of the VHD, then run from elevated Windows PowerShell:

```powershell
.\runner-host\windows-wsl-runner-workspace.ps1 -Mode Compact `
  -VhdPath 'C:\RunnerStorage\runner-work.vhdx' -ConfirmIdle -ConfirmDetached
```

`Compact` requires the operator to confirm that WSL already detached the VHD;
it does not stop services, detach storage, or delete files.
