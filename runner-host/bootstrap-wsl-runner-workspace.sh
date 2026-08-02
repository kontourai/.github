#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bootstrap-wsl-runner-workspace.sh --uuid UUID --mount-root PATH \
  --bind SOURCE:TARGET [--bind SOURCE:TARGET ...] \
  [--service SERVICE ...]

Mounts the ext4 filesystem identified by UUID, bind-mounts each source below
that filesystem over its runner target, then starts the named services. Run as
root from systemd before those runner services start.
EOF
}

uuid=''
mount_root=''
declare -a bindings=()
declare -a services=()

while (($#)); do
  case "$1" in
    --uuid) uuid="${2:?missing UUID}"; shift 2 ;;
    --mount-root) mount_root="${2:?missing mount root}"; shift 2 ;;
    --bind) bindings+=("${2:?missing source:target binding}"); shift 2 ;;
    --service) services+=("${2:?missing service name}"); shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
[[ $uuid =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || { echo 'UUID must be canonical.' >&2; exit 2; }
[[ $mount_root == /* ]] || { echo 'mount root must be absolute.' >&2; exit 2; }
((${#bindings[@]} > 0)) || { echo 'At least one --bind is required.' >&2; exit 2; }
command -v findmnt >/dev/null || { echo 'findmnt is required.' >&2; exit 1; }
command -v mount >/dev/null || { echo 'mount is required.' >&2; exit 1; }

mkdir -p "$mount_root"
if mountpoint -q "$mount_root"; then
  source_uuid="$(findmnt -no UUID --target "$mount_root" || true)"
  [[ ${source_uuid,,} == ${uuid,,} ]] || { echo "mount root is occupied by UUID ${source_uuid:-unknown}, expected $uuid" >&2; exit 1; }
else
  device="$(blkid -U "$uuid" || true)"
  [[ -n $device && -b $device ]] || { echo "No block device found for UUID $uuid. Ensure the Windows VHD is attached first." >&2; exit 1; }
  mount -U "$uuid" "$mount_root"
fi

for binding in "${bindings[@]}"; do
  source_path="${binding%%:*}"
  target_path="${binding#*:}"
  [[ $source_path != "$binding" && $source_path == /* && $target_path == /* ]] || { echo "binding must be absolute SOURCE:TARGET: $binding" >&2; exit 2; }
  case "$source_path" in "$mount_root"/*) ;; *) echo "source must be below mount root: $source_path" >&2; exit 2;; esac
  mkdir -p "$source_path" "$target_path"
  if mountpoint -q "$target_path"; then
    current_source="$(findmnt -no SOURCE --target "$target_path" || true)"
    [[ $current_source == "$source_path" ]] || { echo "target already has a different mount: $target_path" >&2; exit 1; }
  else
    mount --bind "$source_path" "$target_path"
  fi
done

for service in "${services[@]}"; do
  systemctl start "$service"
done
