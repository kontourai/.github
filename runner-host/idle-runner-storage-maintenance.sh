#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  idle-runner-storage-maintenance.sh begin --confirm-idle --mount-root PATH \
    --drain-state PATH --service SERVICE [--service SERVICE ...]
  idle-runner-storage-maintenance.sh end --confirm-drain-end --drain-state PATH

begin persistently masks the declared, inactive runner services and records the
drain. Keep that state in place through WSL unmount, Windows detach, and VHD
compaction. end removes only the recorded masks after the workspace mount is
back. It does not start runner services.
EOF
}

mode="${1:-}"
[[ -n $mode ]] || { usage >&2; exit 2; }
shift || true
command -v realpath >/dev/null || { echo 'realpath is required.' >&2; exit 1; }
confirm_idle=''; confirm_drain_end=''; mount_root=''; drain_state=''
declare -a services=()
while (($#)); do
  case "$1" in
    --confirm-idle) confirm_idle=yes; shift ;;
    --confirm-drain-end) confirm_drain_end=yes; shift ;;
    --mount-root) mount_root="${2:?missing mount root}"; shift 2 ;;
    --drain-state) drain_state="${2:?missing drain state}"; shift 2 ;;
    --service) services+=("${2:?missing service}"); shift 2 ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

require_drain_state_path() {
  [[ $drain_state == /* && $drain_state != *$'\n'* ]] || { echo 'drain-state must be an absolute, single-line path.' >&2; exit 2; }
  [[ $(realpath -m -- "$drain_state") == "$drain_state" ]] || { echo 'drain-state must be canonical and may not traverse symlinks.' >&2; exit 2; }
}

require_service_name() {
  [[ $1 =~ ^[A-Za-z0-9@_.:-]+\.service$ ]] || { echo "service must be a simple .service unit name: $1" >&2; exit 2; }
}

write_drain_state() {
  local state_directory state_tmp service
  state_directory="$(dirname "$drain_state")"
  mkdir -p "$state_directory"
  [[ $(realpath -e -- "$state_directory") == "$state_directory" ]] || { echo 'drain-state parent resolved through a symlink.' >&2; exit 2; }
  state_tmp="$(mktemp "${drain_state}.tmp.XXXXXX")"
  chmod 0600 "$state_tmp"
  {
    printf 'version=1\n'
    printf 'mount_root=%s\n' "$mount_root"
    for service in "${services[@]}"; do printf 'service=%s\n' "$service"; done
  } > "$state_tmp"
  mv "$state_tmp" "$drain_state"
}

read_drain_state() {
  local record key value
  [[ -f $drain_state && ! -L $drain_state ]] || { echo "drain state is missing or unsafe: $drain_state" >&2; exit 2; }
  mount_root=''; services=()
  while IFS= read -r record || [[ -n $record ]]; do
    key="${record%%=*}"
    value="${record#*=}"
    case "$key" in
      version) [[ $value == 1 ]] || { echo "unsupported drain state version: $value" >&2; exit 2; } ;;
      mount_root) [[ -z $mount_root && $value == /* && $value != *$'\n'* ]] || { echo 'invalid drain mount root.' >&2; exit 2; }; mount_root="$value" ;;
      service) require_service_name "$value"; services+=("$value") ;;
      *) echo "invalid drain state record: $key" >&2; exit 2 ;;
    esac
  done < "$drain_state"
  [[ -n $mount_root && ${#services[@]} -gt 0 ]] || { echo 'drain state has no mount root or services.' >&2; exit 2; }
}

begin_drain() {
  local service load_state unit_file_state
  [[ $confirm_idle == yes && $mount_root == /* && -d $mount_root && ${#services[@]} -gt 0 ]] || { usage >&2; exit 2; }
  require_drain_state_path
  [[ ! -e $drain_state ]] || { echo "drain state already exists: $drain_state. Finish or recover that drain before beginning another." >&2; exit 1; }
  for service in "${services[@]}"; do
    require_service_name "$service"
    load_state="$(systemctl show --property=LoadState --value "$service" 2>/dev/null || true)"
    [[ $load_state == loaded ]] || { echo "unknown service unit: $service" >&2; exit 2; }
    unit_file_state="$(systemctl show --property=UnitFileState --value "$service" 2>/dev/null || true)"
    [[ $unit_file_state != masked && $unit_file_state != masked-runtime ]] || { echo "service is already masked outside this drain: $service" >&2; exit 1; }
    [[ $(systemctl is-active "$service" || true) == inactive ]] || { echo "service is not explicitly inactive: $service" >&2; exit 1; }
  done
  write_drain_state
  for service in "${services[@]}"; do
    systemctl mask "$service" >/dev/null
    [[ $(systemctl is-active "$service" || true) == inactive ]] || { echo "service restarted while beginning drain: $service. Keep the drain state and recover with: $0 end --confirm-drain-end --drain-state $drain_state" >&2; exit 1; }
  done
  pgrep -f '[R]unner\.(Worker|Listener)' >/dev/null && { echo "Runner.Worker or Runner.Listener is still active. Keep services masked, stop the process, then rerun: $0 end --confirm-drain-end --drain-state $drain_state" >&2; exit 1; }
  if ! fstrim -v "$mount_root"; then
    echo "Trim failed. Keep services masked and either retry the drain or recover with: $0 end --confirm-drain-end --drain-state $drain_state" >&2
    exit 1
  fi
  cat <<EOF
Drain begun and runner services are persistently masked.
Keep $drain_state until the VHD is reattached and the workspace mount is back.
Next: unmount the bind targets and $mount_root in WSL, detach and compact the VHD in Windows, reattach it, and run the UUID bootstrap. Then run:
  $0 end --confirm-drain-end --drain-state $drain_state
EOF
}

end_drain() {
  local service unit_file_state unmask_failed=no
  [[ $confirm_drain_end == yes && ${#services[@]} -eq 0 && -z $mount_root ]] || { usage >&2; exit 2; }
  require_drain_state_path
  read_drain_state
  mountpoint -q "$mount_root" || { echo "workspace mount is not back: $mount_root. Keep services masked, restore the UUID mount and bindings, then rerun: $0 end --confirm-drain-end --drain-state $drain_state" >&2; exit 1; }
  for service in "${services[@]}"; do
    if ! systemctl unmask "$service" >/dev/null; then
      echo "could not remove maintenance mask for $service" >&2
      unmask_failed=yes
      continue
    fi
    unit_file_state="$(systemctl show --property=UnitFileState --value "$service" 2>/dev/null || true)"
    [[ $unit_file_state != masked && $unit_file_state != masked-runtime ]] || { echo "maintenance mask remains for $service" >&2; unmask_failed=yes; }
  done
  if [[ $unmask_failed == yes ]]; then
    echo "Recovery: keep the VHD attached and the runner services stopped; repair the listed systemd masks, then rerun: $0 end --confirm-drain-end --drain-state $drain_state" >&2
    exit 1
  fi
  rm -f -- "$drain_state"
  echo 'Drain ended. Runner services remain stopped; start them only through the verified UUID bootstrap path.'
}

case "$mode" in
  begin) begin_drain ;;
  end) end_drain ;;
  *) usage >&2; exit 2 ;;
esac
