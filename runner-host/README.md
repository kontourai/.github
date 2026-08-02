# Windows + WSL runner workspace on an SSD-backed VHD

This kit moves mutable WSL runner work trees off a slow WSL distribution VHD
without coupling the setup to any repository, host name, runner name, or disk
letter. It does not change a live host by itself.

## Safety model

- The Windows script requires elevation, creates a VHD only when its path is
  absent, and refuses to overwrite an existing file.
- Windows attaches the VHD but never initializes or formats its disk. Format it
  once from the selected WSL distribution after confirming the disk identity.
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

Create the Windows startup attachment task only after the VHD has been
formatted and the WSL bootstrap has been tested manually:

```powershell
.\runner-host\windows-wsl-runner-workspace.ps1 -Mode InstallBootTask `
  -VhdPath 'C:\RunnerStorage\runner-work.vhdx' -DistroName 'Ubuntu'
```

The boot task attaches by VHD path; the Linux bootstrap finds the ext4 volume
by UUID. To recover, stop the runner services, unmount the bind targets and
mount root in WSL, then detach the VHD in Windows only after no process has an
open file on it. Keep the VHD file: it is the recoverable workspace state.
