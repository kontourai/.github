#!/usr/bin/env bash
set -euo pipefail

usage() { echo 'Usage: idle-runner-storage-maintenance.sh --confirm-idle --mount-root PATH --service SERVICE [--service SERVICE ...]'; }
confirm=''; mount_root=''; declare -a services=()
while (($#)); do
  case "$1" in
    --confirm-idle) confirm=yes; shift ;;
    --mount-root) mount_root="${2:?missing mount root}"; shift 2 ;;
    --service) services+=("${2:?missing service}" ); shift 2 ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ $confirm == yes && $mount_root == /* && -d $mount_root && ${#services[@]} -gt 0 ]] || { usage >&2; exit 2; }
for service in "${services[@]}"; do
  systemctl is-active --quiet "$service" && { echo "service is active: $service" >&2; exit 1; }
done
pgrep -f '[R]unner.Worker' >/dev/null && { echo 'Runner.Worker is still active.' >&2; exit 1; }
fstrim -v "$mount_root"
echo 'Trim complete. Compact the detached VHD from elevated Windows PowerShell only after repeating these idle checks.'
