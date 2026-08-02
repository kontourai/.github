#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  idle-runner-storage-maintenance.sh begin --confirm-idle --uuid UUID --mount-root PATH \
    --bind SOURCE:TARGET [--bind SOURCE:TARGET ...] --drain-state PATH \
    --service SERVICE [--service SERVICE ...]
  idle-runner-storage-maintenance.sh end --confirm-drain-end --drain-state PATH

begin persistently masks the declared, inactive runner services and records the
volume UUID plus every bind identity. Keep that state through WSL unmount,
Windows detach, and VHD compaction. end removes masks only after the restored
mount and bind identities match the recorded state. It does not start services.
EOF
}

mode="${1:-}"
[[ -n $mode ]] || { usage >&2; exit 2; }
shift || true
command -v realpath >/dev/null || { echo 'realpath is required.' >&2; exit 1; }
command -v findmnt >/dev/null || { echo 'findmnt is required.' >&2; exit 1; }
confirm_idle=''; confirm_drain_end=''; uuid=''; mount_root=''; drain_state=''
declare -a services=() bindings=() binding_sources=() binding_targets=() binding_fsroots=()
while (($#)); do
  case "$1" in
    --confirm-idle) confirm_idle=yes; shift ;;
    --confirm-drain-end) confirm_drain_end=yes; shift ;;
    --uuid) uuid="${2:?missing UUID}"; shift 2 ;;
    --mount-root) mount_root="${2:?missing mount root}"; shift 2 ;;
    --bind) bindings+=("${2:?missing source:target binding}"); shift 2 ;;
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

require_uuid() {
  [[ $uuid =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || { echo 'UUID must be canonical.' >&2; exit 2; }
}

require_service_name() {
  [[ $1 =~ ^[A-Za-z0-9@_.:-]+\.service$ ]] || { echo "service must be a simple .service unit name: $1" >&2; exit 2; }
}

same_uuid() { [[ ${1,,} == ${2,,} ]]; }

validate_and_capture_bindings() {
  local binding source_input target_input source_path target_path source_uuid target_uuid target_fsroot source_fsroot
  [[ $(realpath -e -- "$mount_root") == "$mount_root" ]] || { echo 'mount-root must be an existing canonical directory.' >&2; exit 2; }
  same_uuid "$(findmnt -no UUID --target "$mount_root" || true)" "$uuid" || { echo "mount-root is not mounted from UUID $uuid: $mount_root" >&2; exit 1; }
  binding_sources=(); binding_targets=(); binding_fsroots=()
  for binding in "${bindings[@]}"; do
    source_input="${binding%%:*}"; target_input="${binding#*:}"
    [[ $source_input != "$binding" && $source_input == /* && $target_input == /* && $source_input != *'|'* && $target_input != *'|'* ]] || { echo "binding must be absolute SOURCE:TARGET without '|': $binding" >&2; exit 2; }
    source_path="$(realpath -e -- "$source_input")"; target_path="$(realpath -e -- "$target_input")"
    [[ $source_path == "$source_input" && $target_path == "$target_input" ]] || { echo "binding paths must be canonical and may not traverse symlinks: $binding" >&2; exit 2; }
    case "$source_path" in "$mount_root"/*) ;; *) echo "source must be below mount root: $source_path" >&2; exit 2 ;; esac
    source_fsroot="${source_path#"$mount_root"}"
    source_uuid="$(findmnt -no UUID --target "$source_path" || true)"
    target_uuid="$(findmnt -no UUID --target "$target_path" || true)"
    target_fsroot="$(findmnt -no FSROOT --target "$target_path" || true)"
    same_uuid "$source_uuid" "$uuid" && same_uuid "$target_uuid" "$uuid" && [[ $target_fsroot == "$source_fsroot" ]] || { echo "binding does not match UUID and filesystem-root identity: $binding" >&2; exit 1; }
    binding_sources+=("$source_path"); binding_targets+=("$target_path"); binding_fsroots+=("$source_fsroot")
  done
}

write_drain_state() {
  local state_directory state_tmp service index
  state_directory="$(dirname "$drain_state")"
  mkdir -p "$state_directory"
  [[ $(realpath -e -- "$state_directory") == "$state_directory" ]] || { echo 'drain-state parent resolved through a symlink.' >&2; exit 2; }
  state_tmp="$(mktemp "${drain_state}.tmp.XXXXXX")"
  chmod 0600 "$state_tmp"
  {
    printf 'version=2\n'
    printf 'uuid=%s\n' "$uuid"
    printf 'mount_root=%s\n' "$mount_root"
    for index in "${!binding_sources[@]}"; do printf 'binding=%s|%s|%s\n' "${binding_sources[$index]}" "${binding_targets[$index]}" "${binding_fsroots[$index]}"; done
    for service in "${services[@]}"; do printf 'service=%s\n' "$service"; done
  } > "$state_tmp"
  mv "$state_tmp" "$drain_state"
}

read_drain_state() {
  local record key value source target fsroot
  [[ -f $drain_state && ! -L $drain_state ]] || { echo "drain state is missing or unsafe: $drain_state" >&2; exit 2; }
  uuid=''; mount_root=''; services=(); binding_sources=(); binding_targets=(); binding_fsroots=()
  while IFS= read -r record || [[ -n $record ]]; do
    key="${record%%=*}"; value="${record#*=}"
    case "$key" in
      version) [[ $value == 2 ]] || { echo "unsupported drain state version: $value" >&2; exit 2; } ;;
      uuid) [[ -z $uuid ]] || { echo 'duplicate drain UUID.' >&2; exit 2; }; uuid="$value"; require_uuid ;;
      mount_root) [[ -z $mount_root && $value == /* && $value != *$'\n'* ]] || { echo 'invalid drain mount root.' >&2; exit 2; }; mount_root="$value" ;;
      binding)
        IFS='|' read -r source target fsroot <<< "$value"
        [[ -n $source && -n $target && -n $fsroot && $source == /* && $target == /* && $fsroot == /* ]] || { echo 'invalid drain binding identity.' >&2; exit 2; }
        binding_sources+=("$source"); binding_targets+=("$target"); binding_fsroots+=("$fsroot") ;;
      service) require_service_name "$value"; services+=("$value") ;;
      *) echo "invalid drain state record: $key" >&2; exit 2 ;;
    esac
  done < "$drain_state"
  [[ -n $uuid && -n $mount_root && ${#binding_sources[@]} -gt 0 && ${#services[@]} -gt 0 ]] || { echo 'drain state has no UUID, mount root, bindings, or services.' >&2; exit 2; }
}

validate_restored_identities() {
  local index restored_uuid restored_fsroot
  mountpoint -q "$mount_root" || { echo "workspace mount is not back: $mount_root" >&2; return 1; }
  same_uuid "$(findmnt -no UUID --target "$mount_root" || true)" "$uuid" || { echo "workspace mount UUID no longer matches drain state: $mount_root" >&2; return 1; }
  for index in "${!binding_sources[@]}"; do
    restored_uuid="$(findmnt -no UUID --target "${binding_targets[$index]}" || true)"
    restored_fsroot="$(findmnt -no FSROOT --target "${binding_targets[$index]}" || true)"
    same_uuid "$restored_uuid" "$uuid" && [[ $restored_fsroot == "${binding_fsroots[$index]}" ]] || { echo "restored bind identity does not match drain state: ${binding_targets[$index]}" >&2; return 1; }
  done
}

remask_all_services() {
  local service remask_failed=no
  for service in "${services[@]}"; do
    systemctl mask "$service" >/dev/null || { echo "could not re-mask $service after drain failure" >&2; remask_failed=yes; }
  done
  [[ $remask_failed == no ]]
}

begin_drain() {
  local service load_state unit_file_state
  [[ $confirm_idle == yes && $mount_root == /* && -d $mount_root && ${#bindings[@]} -gt 0 && ${#services[@]} -gt 0 ]] || { usage >&2; exit 2; }
  require_drain_state_path; require_uuid
  [[ ! -e $drain_state ]] || { echo "drain state already exists: $drain_state. Finish or recover that drain before beginning another." >&2; exit 1; }
  validate_and_capture_bindings
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
  if ! fstrim -v "$mount_root"; then echo "Trim failed. Keep services masked and either retry the drain or recover with: $0 end --confirm-drain-end --drain-state $drain_state" >&2; exit 1; fi
  echo "Drain begun and runner services are persistently masked. Keep $drain_state through unmount, detach, compaction, reattach, and UUID/bind restoration."
}

end_drain() {
  local service unit_file_state unmask_failed=no
  [[ $confirm_drain_end == yes && ${#services[@]} -eq 0 && -z $mount_root && -z $uuid && ${#bindings[@]} -eq 0 ]] || { usage >&2; exit 2; }
  require_drain_state_path; read_drain_state
  if ! validate_restored_identities; then
    echo "Recovery: keep all services masked, restore the recorded UUID and binds, then rerun: $0 end --confirm-drain-end --drain-state $drain_state" >&2
    exit 1
  fi
  for service in "${services[@]}"; do
    if ! systemctl unmask "$service" >/dev/null; then echo "could not remove maintenance mask for $service" >&2; unmask_failed=yes; continue; fi
    unit_file_state="$(systemctl show --property=UnitFileState --value "$service" 2>/dev/null || true)"
    [[ $unit_file_state != masked && $unit_file_state != masked-runtime ]] || { echo "maintenance mask remains for $service" >&2; unmask_failed=yes; }
  done
  if [[ $unmask_failed == yes ]]; then
    if remask_all_services; then
      echo "Recovery: all declared services were re-masked. Keep the VHD attached, repair the listed systemd masks, then rerun: $0 end --confirm-drain-end --drain-state $drain_state" >&2
    else
      echo "CRITICAL recovery state: rollback re-masking is incomplete and one or more runners may be fail-open. The drain state and any storage incident marker remain in force. Do not re-enable the scheduled task or start runners. Immediately run for every declared service:" >&2
      for service in "${services[@]}"; do printf '  systemctl stop %q && systemctl mask %q\n' "$service" "$service" >&2; done
      echo "After every service is masked, keep $drain_state and rerun: $0 end --confirm-drain-end --drain-state $drain_state" >&2
    fi
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
