#!/usr/bin/env bash
# Bootstrap macOS/Linux; không cần sudo hoặc Git.
set -euo pipefail

fail() { printf 'pi-config: %s\n' "$*" >&2; exit 1; }
for dependency in curl tar mktemp; do
  command -v "$dependency" >/dev/null 2>&1 || fail "Cần cài $dependency trước khi chạy installer."
done

node_version=24.15.0
case "$(uname -s)" in
  Darwin) node_os=darwin ;;
  Linux) node_os=linux ;;
  *) fail 'Bootstrap này dành cho macOS/Linux. Windows dùng install.ps1.' ;;
esac
case "$(uname -m)" in
  arm64|aarch64) node_arch=arm64 ;;
  x86_64|amd64) node_arch=x64 ;;
  *) fail 'Chỉ hỗ trợ x64 và ARM64.' ;;
esac

case "$node_os-$node_arch" in
  darwin-arm64) node_sha=372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4 ;;
  darwin-x64) node_sha=ffd5ee293467927f3ee731a553eb88fd1f48cf74eebc2d74a6babe4af228673b ;;
  linux-arm64) node_sha=73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed ;;
  linux-x64) node_sha=44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89 ;;
esac

verify_sha256() {
  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$1")
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$1")
  else
    fail 'Cần sha256sum hoặc shasum để kiểm tra file tải về.'
  fi
  actual=${actual%% *}
  [ "$actual" = "$2" ] || fail "SHA256 không khớp: $1"
}

task_temp=$(mktemp -d "${TMPDIR:-/tmp}/pi-config-bootstrap.XXXXXXXX")
trap 'rm -rf "$task_temp"' EXIT
bootstrap_dir=${PI_CONFIG_BOOTSTRAP_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-config/bootstrap}
node_dir="$bootstrap_dir/node-v$node_version-$node_os-$node_arch"
node_command=$(command -v node || true)
if [ "${PI_CONFIG_FRESH_TOOLCHAIN:-0}" = 1 ]; then node_command=; fi
if [ -z "$node_command" ] || [ "$("$node_command" --version 2>/dev/null || true)" != "v$node_version" ]; then
  node_command="$node_dir/bin/node"
  if [ ! -x "$node_command" ] || [ "$("$node_command" --version 2>/dev/null || true)" != "v$node_version" ]; then
    [ ! -e "$node_dir" ] || fail "Toolchain chưa hoàn chỉnh: $node_dir. Hãy đổi PI_CONFIG_BOOTSTRAP_DIR hoặc kiểm tra thư mục này."
    node_archive="node-v$node_version-$node_os-$node_arch.tar.gz"
    printf 'Tải Node %s (%s/%s), kiểm SHA256...\n' "$node_version" "$node_os" "$node_arch"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 300 --retry 2 \
      "https://nodejs.org/dist/v$node_version/$node_archive" -o "$task_temp/$node_archive"
    verify_sha256 "$task_temp/$node_archive" "$node_sha"
    tar -xzf "$task_temp/$node_archive" -C "$task_temp"
    "$task_temp/node-v$node_version-$node_os-$node_arch/bin/node" --version >/dev/null || \
      fail 'Node không chạy được. Linux cần glibc tương thích; Alpine/musl chưa hỗ trợ.'
    mkdir -p "$bootstrap_dir"
    mv "$task_temp/node-v$node_version-$node_os-$node_arch" "$node_dir"
  fi
fi
export PATH="$(dirname "$node_command"):$PATH"

if [ -n "${PI_CONFIG_SOURCE:-}" ]; then
  source_dir=$PI_CONFIG_SOURCE
else
  repo_ref=${PI_CONFIG_REF:-main}
  case "$repo_ref" in
    ''|*[!A-Za-z0-9._/-]*|-*) fail 'PI_CONFIG_REF phải là commit, tag hoặc branch hợp lệ.' ;;
  esac
  printf 'Tải duy-tung/pi-config (%s)...\n' "$repo_ref"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 300 --retry 2 \
    "https://github.com/duy-tung/pi-config/archive/$repo_ref.tar.gz" -o "$task_temp/pi-config.tar.gz"
  mkdir "$task_temp/source"
  tar -xzf "$task_temp/pi-config.tar.gz" -C "$task_temp/source" --strip-components=1
  source_dir="$task_temp/source"
fi
[ -f "$source_dir/install.mjs" ] || fail "Không tìm thấy install.mjs trong $source_dir"
"$node_command" "$source_dir/install.mjs" "$@"
