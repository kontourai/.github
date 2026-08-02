#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  runner-storage-health.sh probe --probe-path PATH --incident-path PATH \
    [--timeout-seconds N] [--service SERVICE ...]
  runner-storage-health.sh watch --probe-path PATH --incident-path PATH \
    [--timeout-seconds N] [--interval-seconds N] [--service SERVICE ...]
  runner-storage-health.sh contain [--probe-path PATH] [--incident-path PATH] \
    --service SERVICE [--service SERVICE ...]
  runner-storage-health.sh clear --probe-path PATH --incident-path PATH \
    [--timeout-seconds N] [--service SERVICE ...]

probe writes and fsyncs one 4 KiB temporary file on the probe path. Failure or
timeout persists an incident marker, stops and masks every declared service,
and fails closed. watch repeats probe until an incident. contain is the trusted
watcher-exit fail-safe: it stops and masks before attempting optional marker
or storage-identity recording. clear requires an existing matching marker and
a new passing probe before unmasking services; it never starts them.
EOF
}

mode="${1:-}"
[[ -n $mode ]] || { usage >&2; exit 2; }
shift || true
probe_path=''; incident_path=''; timeout_seconds=30; interval_seconds=60
declare -a services=()
while (($#)); do
  case "$1" in
    --probe-path) probe_path="${2:?missing probe path}"; shift 2 ;;
    --incident-path) incident_path="${2:?missing incident path}"; shift 2 ;;
    --timeout-seconds) timeout_seconds="${2:?missing timeout seconds}"; shift 2 ;;
    --interval-seconds) interval_seconds="${2:?missing interval seconds}"; shift 2 ;;
    --service) services+=("${2:?missing service}"); shift 2 ;;
    --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

require_service_name() { [[ $1 =~ ^[A-Za-z0-9@_.:-]+\.service$ ]] || { echo "service must be a simple .service unit name: $1" >&2; exit 2; }; }
require_positive_integer() { [[ $1 =~ ^[1-9][0-9]*$ ]] || { echo "$2 must be a positive integer." >&2; exit 2; }; }

require_paths() {
  command -v timeout >/dev/null || { echo 'timeout is required.' >&2; exit 1; }
  command -v dd >/dev/null || { echo 'dd is required.' >&2; exit 1; }
  command -v findmnt >/dev/null || { echo 'findmnt is required.' >&2; exit 1; }
  command -v realpath >/dev/null || { echo 'realpath is required.' >&2; exit 1; }
  command -v systemctl >/dev/null || { echo 'systemctl is required.' >&2; exit 1; }
  [[ $probe_path == /* && $probe_path != *$'\n'* && -d $probe_path && $(realpath -e -- "$probe_path") == "$probe_path" ]] || { echo 'probe-path must be an existing canonical absolute directory.' >&2; exit 2; }
  [[ $incident_path == /* && $incident_path != *$'\n'* && $(realpath -m -- "$incident_path") == "$incident_path" ]] || { echo 'incident-path must be a canonical absolute path.' >&2; exit 2; }
  require_positive_integer "$timeout_seconds" timeout-seconds
  require_positive_integer "$interval_seconds" interval-seconds
  for service in "${services[@]}"; do require_service_name "$service"; done
}

require_containment() {
  command -v systemctl >/dev/null || { echo 'systemctl is required for emergency containment.' >&2; exit 1; }
  ((${#services[@]} > 0)) || { echo 'emergency containment requires at least one --service.' >&2; exit 2; }
  for service in "${services[@]}"; do require_service_name "$service"; done
}

can_record_containment_incident() {
  [[ -n $probe_path && -n $incident_path ]] || return 1
  command -v findmnt >/dev/null && command -v realpath >/dev/null || return 1
  [[ $probe_path == /* && $probe_path != *$'\n'* && -d $probe_path && $(realpath -e -- "$probe_path") == "$probe_path" ]] || return 1
  [[ $incident_path == /* && $incident_path != *$'\n'* && $(realpath -m -- "$incident_path") == "$incident_path" ]] || return 1
}

print_containment_recovery() {
  local service
  echo 'CRITICAL: runner storage containment is incomplete; one or more runners may still be active or unmasked. Do not start runners or re-enable the scheduled task. Immediately run for every declared service:' >&2
  for service in "${services[@]}"; do
    printf '  systemctl stop %q && systemctl mask %q\n' "$service" "$service" >&2
  done
}

contain_services() {
  local service state failed=no
  for service in "${services[@]}"; do
    if ! systemctl stop "$service" >/dev/null 2>&1; then
      echo "could not stop $service during storage containment" >&2
      failed=yes
    fi
    if systemctl is-active --quiet "$service" >/dev/null 2>&1; then
      echo "$service remains active after storage containment stop" >&2
      failed=yes
    fi
    if ! systemctl mask "$service" >/dev/null 2>&1; then
      echo "could not mask $service during storage containment" >&2
      failed=yes
    fi
    state="$(systemctl show --property=UnitFileState --value "$service" 2>/dev/null || true)"
    if [[ $state != masked && $state != masked-runtime ]]; then
      echo "$service is not masked after storage containment" >&2
      failed=yes
    fi
  done
  [[ $failed == no ]]
}

unmask_services() {
  local service failed=no
  for service in "${services[@]}"; do
    systemctl unmask "$service" >/dev/null 2>&1 || { echo "could not remove health incident mask for $service" >&2; failed=yes; }
  done
  [[ $failed == no ]]
}

write_incident() {
  local reason="$1" exit_code="$2" incident_dir incident_tmp service filesystem_uuid filesystem_fsroot
  incident_dir="$(dirname "$incident_path")"
  mkdir -p "$incident_dir" || return 1
  [[ $(realpath -e -- "$incident_dir") == "$incident_dir" ]] || { echo 'incident parent resolved through a symlink.' >&2; return 1; }
  incident_tmp="$(mktemp "${incident_path}.tmp.XXXXXX")" || return 1
  chmod 0600 "$incident_tmp" || { rm -f -- "$incident_tmp"; return 1; }
  filesystem_uuid="$(findmnt -no UUID --target "$probe_path" 2>/dev/null || true)"
  filesystem_fsroot="$(findmnt -no FSROOT --target "$probe_path" 2>/dev/null || true)"
  if [[ -z $filesystem_uuid || -z $filesystem_fsroot ]]; then
    echo 'could not record probe filesystem identity in health incident marker.' >&2
    rm -f -- "$incident_tmp"
    return 1
  fi
  {
    printf 'version=1\n'
    printf 'at=%s\n' "$(date -u +%FT%TZ)"
    printf 'reason=%s\n' "$reason"
    printf 'exit_code=%s\n' "$exit_code"
    printf 'probe_path=%s\n' "$probe_path"
    printf 'filesystem_uuid=%s\n' "$filesystem_uuid"
    printf 'filesystem_fsroot=%s\n' "$filesystem_fsroot"
    for service in "${services[@]}"; do printf 'service=%s\n' "$service"; done
  } > "$incident_tmp" || { rm -f -- "$incident_tmp"; return 1; }
  mv "$incident_tmp" "$incident_path" || { rm -f -- "$incident_tmp"; return 1; }
}

perform_probe() {
  local probe_file result reason incident_written=yes
  umask 077
  probe_file="$(mktemp "${probe_path}/.kontour-storage-health.XXXXXX")"
  if timeout --foreground --kill-after=2s "${timeout_seconds}s" dd if=/dev/zero of="$probe_file" bs=4096 count=1 conv=fsync status=none; then
    rm -f -- "$probe_file"
    return 0
  else
    result=$?
  fi
  rm -f -- "$probe_file" || true
  reason=write-fsync-failed
  [[ $result -eq 124 || $result -eq 137 ]] && reason=timeout
  if ! write_incident "$reason" "$result"; then
    incident_written=no
    echo "CRITICAL: could not persist runner storage health incident at $incident_path." >&2
  fi
  if ! contain_services; then
    print_containment_recovery
    return 1
  fi
  if [[ $incident_written != yes ]]; then
    echo 'CRITICAL: services were contained but the incident marker could not be persisted.' >&2
    return 1
  fi
  echo "Runner storage health incident ($reason) persisted at $incident_path; services were stopped and masked." >&2
  return 1
}

marker_exists() { [[ -e $incident_path || -L $incident_path ]]; }
marker_is_regular() { [[ -f $incident_path && ! -L $incident_path ]]; }

declare marker_version marker_at marker_reason marker_exit_code marker_probe_path marker_filesystem_uuid marker_filesystem_fsroot
declare -a marker_services=()

parse_incident_marker() {
  local line key value seen_version=no seen_at=no seen_reason=no seen_exit_code=no seen_probe_path=no seen_uuid=no seen_fsroot=no
  marker_version=''; marker_at=''; marker_reason=''; marker_exit_code=''; marker_probe_path=''; marker_filesystem_uuid=''; marker_filesystem_fsroot=''; marker_services=()
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == *=* ]] || { echo 'health incident marker contains a malformed line.' >&2; return 1; }
    key="${line%%=*}"; value="${line#*=}"
    case "$key" in
      version) [[ $seen_version == no && $value == 1 ]] || { echo 'health incident marker has an invalid version.' >&2; return 1; }; marker_version="$value"; seen_version=yes ;;
      at) [[ $seen_at == no && $value =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo 'health incident marker has an invalid timestamp.' >&2; return 1; }; marker_at="$value"; seen_at=yes ;;
      reason) [[ $seen_reason == no && $value =~ ^(timeout|write-fsync-failed|watcher-exited)$ ]] || { echo 'health incident marker has an invalid reason.' >&2; return 1; }; marker_reason="$value"; seen_reason=yes ;;
      exit_code) [[ $seen_exit_code == no && $value =~ ^[0-9]+$ ]] || { echo 'health incident marker has an invalid exit code.' >&2; return 1; }; marker_exit_code="$value"; seen_exit_code=yes ;;
      probe_path) [[ $seen_probe_path == no && $value == /* && $value != *$'\n'* ]] || { echo 'health incident marker has an invalid probe path.' >&2; return 1; }; marker_probe_path="$value"; seen_probe_path=yes ;;
      filesystem_uuid) [[ $seen_uuid == no && -n $value ]] || { echo 'health incident marker has an invalid filesystem UUID.' >&2; return 1; }; marker_filesystem_uuid="$value"; seen_uuid=yes ;;
      filesystem_fsroot) [[ $seen_fsroot == no && $value == /* ]] || { echo 'health incident marker has an invalid filesystem root.' >&2; return 1; }; marker_filesystem_fsroot="$value"; seen_fsroot=yes ;;
      service) [[ $value =~ ^[A-Za-z0-9@_.:-]+\.service$ ]] || { echo 'health incident marker has an invalid service.' >&2; return 1; }; marker_services+=("$value") ;;
      *) echo "health incident marker has an unknown field: $key" >&2; return 1 ;;
    esac
  done < "$incident_path"
  [[ $seen_version == yes && $seen_at == yes && $seen_reason == yes && $seen_exit_code == yes && $seen_probe_path == yes && $seen_uuid == yes && $seen_fsroot == yes ]] || { echo 'health incident marker is missing required fields.' >&2; return 1; }
}

validate_marker_for_clear() {
  local current_uuid current_fsroot index
  parse_incident_marker || return 1
  current_uuid="$(findmnt -no UUID --target "$probe_path" 2>/dev/null || true)"
  current_fsroot="$(findmnt -no FSROOT --target "$probe_path" 2>/dev/null || true)"
  [[ -n $current_uuid && -n $current_fsroot ]] || { echo 'could not verify the current probe filesystem identity.' >&2; return 1; }
  [[ $marker_probe_path == "$probe_path" ]] || { echo 'health incident marker probe path does not match this clear request.' >&2; return 1; }
  [[ $marker_filesystem_uuid == "$current_uuid" && $marker_filesystem_fsroot == "$current_fsroot" ]] || { echo 'health incident marker filesystem identity does not match this clear request.' >&2; return 1; }
  [[ ${#marker_services[@]} -eq ${#services[@]} ]] || { echo 'health incident marker services do not match this clear request.' >&2; return 1; }
  for index in "${!services[@]}"; do
    [[ ${marker_services[$index]} == "${services[$index]}" ]] || { echo 'health incident marker services do not match this clear request.' >&2; return 1; }
  done
}

contain_after_marker_problem() {
  if ! contain_services; then print_containment_recovery; fi
}

refuse_marker() {
  marker_exists || return 1
  if ! marker_is_regular; then
    contain_after_marker_problem
    echo "CRITICAL: health incident marker is malformed or non-regular: $incident_path. Refusing automatic restart." >&2
    return 0
  fi
  if ! parse_incident_marker; then
    contain_after_marker_problem
    echo "CRITICAL: health incident marker is malformed: $incident_path. Refusing automatic restart." >&2
    return 0
  fi
  contain_after_marker_problem
  echo "Runner storage incident marker exists: $incident_path. Refusing automatic restart; run the verified clear command after storage recovery." >&2
  return 0
}

case "$mode" in
  probe)
    require_paths
    if refuse_marker; then exit 1; fi
    perform_probe
    ;;
  watch)
    require_paths
    while :; do
      if refuse_marker; then exit 1; fi
      perform_probe || exit 1
      sleep "$interval_seconds"
    done
    ;;
  contain)
    require_containment
    if ! contain_services; then
      print_containment_recovery
      exit 1
    fi
    if marker_exists; then
      echo "Runner storage watcher containment preserved existing marker at ${incident_path:-unconfigured path}; services were stopped and masked." >&2
    elif can_record_containment_incident && write_incident watcher-exited 1; then
      echo "Runner storage watcher containment persisted at $incident_path; services were stopped and masked." >&2
    else
      echo 'CRITICAL: services were stopped and masked, but emergency containment could not record a storage incident because probe path, storage identity, or marker tooling is unavailable.' >&2
    fi
    exit 0
    ;;
  clear)
    require_paths
    marker_exists || { echo "no health incident marker to clear: $incident_path" >&2; exit 2; }
    if ! marker_is_regular; then
      contain_after_marker_problem
      echo "CRITICAL: health incident marker is malformed or non-regular: $incident_path. It remains in force." >&2
      exit 1
    fi
    if ! validate_marker_for_clear; then
      contain_after_marker_problem
      echo "CRITICAL: health incident marker does not exactly match this recovery request: $incident_path. It remains in force." >&2
      exit 1
    fi
    marker_path="$incident_path"
    incident_path="${incident_path}.clear-attempt"
    if ! perform_probe; then
      rm -f -- "$incident_path"
      incident_path="$marker_path"
      echo "Recovery probe failed; existing incident remains in force: $marker_path" >&2
      exit 1
    fi
    rm -f -- "$incident_path"
    incident_path="$marker_path"
    if ! unmask_services; then
      if ! contain_services; then print_containment_recovery; fi
      echo "Recovery probe passed but service masks could not be cleared; incident remains: $incident_path" >&2
      exit 1
    fi
    rm -f -- "$incident_path"
    echo 'Storage recovery probe passed and incident marker cleared. Services remain stopped; restart only through the bootstrap path.'
    ;;
  *) usage >&2; exit 2 ;;
esac
