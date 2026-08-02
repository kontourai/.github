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
declare -a runtime_masked_services=()
cleanup_runtime_masks() {
  local service
  for service in "${runtime_masked_services[@]}"; do
    systemctl unmask --runtime "$service" >/dev/null || echo "warning: could not remove runtime mask for $service" >&2
  done
}
trap cleanup_runtime_masks EXIT
for service in "${services[@]}"; do
  load_state="$(systemctl show --property=LoadState --value "$service" 2>/dev/null || true)"
  [[ $load_state == loaded ]] || { echo "unknown service unit: $service" >&2; exit 2; }
  [[ $(systemctl is-active "$service" || true) == inactive ]] || { echo "service is not explicitly inactive: $service" >&2; exit 1; }
done
for service in "${services[@]}"; do
  systemctl mask --runtime "$service" >/dev/null
  runtime_masked_services+=("$service")
  [[ $(systemctl is-active "$service" || true) == inactive ]] || { echo "service restarted while preparing trim: $service" >&2; exit 1; }
done
pgrep -f '[R]unner\.(Worker|Listener)' >/dev/null && { echo 'Runner.Worker or Runner.Listener is still active.' >&2; exit 1; }
fstrim -v "$mount_root"
echo 'Trim complete. Runtime service masks will now be removed. Compact the detached VHD from elevated Windows PowerShell only after repeating these idle checks.'
