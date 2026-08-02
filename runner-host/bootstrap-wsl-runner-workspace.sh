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
command -v realpath >/dev/null || { echo 'realpath is required.' >&2; exit 1; }

canonical_mount_root="$(realpath -m -- "$mount_root")"
[[ $canonical_mount_root == "$mount_root" ]] || { echo "mount root must be canonical and may not traverse symlinks: $mount_root" >&2; exit 2; }
mkdir -p "$mount_root"
mount_root="$(realpath -e -- "$mount_root")"
[[ $mount_root == "$canonical_mount_root" ]] || { echo 'mount root resolved through a symlink.' >&2; exit 2; }
if mountpoint -q "$mount_root"; then
  source_uuid="$(findmnt -no UUID --target "$mount_root" || true)"
  [[ ${source_uuid,,} == ${uuid,,} ]] || { echo "mount root is occupied by UUID ${source_uuid:-unknown}, expected $uuid" >&2; exit 1; }
else
  device="$(blkid -U "$uuid" || true)"
  [[ -n $device && -b $device ]] || { echo "No block device found for UUID $uuid. Ensure the Windows VHD is attached first." >&2; exit 1; }
  mount -U "$uuid" "$mount_root"
fi

for binding in "${bindings[@]}"; do
  source_input="${binding%%:*}"
  target_input="${binding#*:}"
  [[ $source_input != "$binding" && $source_input == /* && $target_input == /* ]] || { echo "binding must be absolute SOURCE:TARGET: $binding" >&2; exit 2; }

  # Reject lexical traversal and existing symlink indirection before mkdir can
  # create a directory outside the declared source or target path.
  source_path="$(realpath -m -- "$source_input")"
  target_path="$(realpath -m -- "$target_input")"
  [[ $source_path == "$source_input" && $target_path == "$target_input" ]] || { echo "binding paths must be canonical and may not traverse symlinks: $binding" >&2; exit 2; }
  case "$source_path" in "$mount_root"/*) ;; *) echo "source must be below mount root: $source_path" >&2; exit 2;; esac
  mkdir -p "$source_path" "$target_path"
  [[ $(realpath -e -- "$source_path") == "$source_path" && $(realpath -e -- "$target_path") == "$target_path" ]] || { echo "binding path resolved through a symlink: $binding" >&2; exit 2; }
  source_uuid="$(findmnt -no UUID --target "$source_path" || true)"
  [[ ${source_uuid,,} == ${uuid,,} ]] || { echo "source is not on the recorded UUID filesystem: $source_path" >&2; exit 1; }
  source_fsroot="${source_path#"$mount_root"}"
  [[ -n $source_fsroot ]] || source_fsroot='/'
  if mountpoint -q "$target_path"; then
    current_uuid="$(findmnt -no UUID --target "$target_path" || true)"
    current_fsroot="$(findmnt -no FSROOT --target "$target_path" || true)"
    [[ ${current_uuid,,} == ${uuid,,} && $current_fsroot == "$source_fsroot" ]] || { echo "target already has a different mount identity: $target_path" >&2; exit 1; }
  else
    mount --bind "$source_path" "$target_path"
  fi
done

for service in "${services[@]}"; do
  systemctl start "$service"
done
