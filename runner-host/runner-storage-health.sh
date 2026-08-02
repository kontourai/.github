#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  runner-storage-health.sh probe --probe-path PATH --incident-path PATH \
    [--timeout-seconds N] [--service SERVICE ...]
  runner-storage-health.sh watch --probe-path PATH --incident-path PATH \
    [--timeout-seconds N] [--interval-seconds N] [--service SERVICE ...]
  runner-storage-health.sh clear --probe-path PATH --incident-path PATH \
    [--timeout-seconds N] [--service SERVICE ...]

probe writes and fsyncs one 4 KiB temporary file on the probe path. Failure or
timeout persists an incident marker, stops and masks every declared service,
and fails closed. watch repeats probe until an incident. clear requires an
existing marker and a new passing probe before unmasking services; it never
starts them.
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
  [[ $probe_path == /* && -d $probe_path && $(realpath -e -- "$probe_path") == "$probe_path" ]] || { echo 'probe-path must be an existing canonical absolute directory.' >&2; exit 2; }
  [[ $incident_path == /* && $incident_path != *$'\n'* && $(realpath -m -- "$incident_path") == "$incident_path" ]] || { echo 'incident-path must be a canonical absolute path.' >&2; exit 2; }
  require_positive_integer "$timeout_seconds" timeout-seconds
  require_positive_integer "$interval_seconds" interval-seconds
  for service in "${services[@]}"; do require_service_name "$service"; done
}

mask_services() {
  local service
  for service in "${services[@]}"; do
    systemctl stop "$service" >/dev/null 2>&1 || true
    systemctl mask "$service" >/dev/null 2>&1 || echo "warning: could not mask $service" >&2
  done
}

unmask_services() {
  local service failed=no
  for service in "${services[@]}"; do
    systemctl unmask "$service" >/dev/null 2>&1 || { echo "could not remove health incident mask for $service" >&2; failed=yes; }
  done
  [[ $failed == no ]]
}

write_incident() {
  local reason="$1" exit_code="$2" incident_dir incident_tmp service
  incident_dir="$(dirname "$incident_path")"
  mkdir -p "$incident_dir"
  [[ $(realpath -e -- "$incident_dir") == "$incident_dir" ]] || { echo 'incident parent resolved through a symlink.' >&2; exit 1; }
  incident_tmp="$(mktemp "${incident_path}.tmp.XXXXXX")"
  chmod 0600 "$incident_tmp"
  {
    printf 'version=1\n'
    printf 'at=%s\n' "$(date -u +%FT%TZ)"
    printf 'reason=%s\n' "$reason"
    printf 'exit_code=%s\n' "$exit_code"
    printf 'probe_path=%s\n' "$probe_path"
    printf 'filesystem_uuid=%s\n' "$(findmnt -no UUID --target "$probe_path" || true)"
    printf 'filesystem_fsroot=%s\n' "$(findmnt -no FSROOT --target "$probe_path" || true)"
    for service in "${services[@]}"; do printf 'service=%s\n' "$service"; done
  } > "$incident_tmp"
  mv "$incident_tmp" "$incident_path"
}

perform_probe() {
  local probe_file result reason
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
  write_incident "$reason" "$result"
  mask_services
  echo "Runner storage health incident ($reason) persisted at $incident_path; services were stopped and masked." >&2
  return 1
}

refuse_marker() {
  [[ -f $incident_path && ! -L $incident_path ]] || return 1
  mask_services
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
  clear)
    require_paths
    [[ -f $incident_path && ! -L $incident_path ]] || { echo "no health incident marker to clear: $incident_path" >&2; exit 2; }
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
      mask_services
      echo "Recovery probe passed but service masks could not be cleared; incident remains: $incident_path" >&2
      exit 1
    fi
    rm -f -- "$incident_path"
    echo 'Storage recovery probe passed and incident marker cleared. Services remain stopped; restart only through the bootstrap path.'
    ;;
  *) usage >&2; exit 2 ;;
esac
