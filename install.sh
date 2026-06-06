#!/usr/bin/env bash
# Gearbox installer — downloads the pre-built binary from GitHub Releases.
#
# Installs to:
#   ~/.local/share/gearbox/<version>/cli.mjs
#   first user-owned PATH bin dir, or ~/.local/bin/gearbox
#
# No npm, no sudo, no system prefix.
set -euo pipefail

REPO="AnayGarodia/gearbox"
VERSION="${GEARBOX_VERSION:-latest}"
INSTALL_ROOT="${GEARBOX_INSTALL_DIR:-${HOME}/.local/share/gearbox}"

default_bin_dir() {
  if [[ -n "${GEARBOX_BIN_DIR:-}" ]]; then
    echo "$GEARBOX_BIN_DIR"
    return
  fi

  # Replace stale user-owned shim if one is already on PATH.
  local existing dir
  existing="$(command -v gearbox 2>/dev/null || true)"
  if [[ -n "$existing" ]]; then
    dir="$(dirname "$existing")"
    if [[ "$dir" == "$HOME"/* && -d "$dir" && -w "$dir" ]]; then
      echo "$dir"
      return
    fi
  fi

  local path_dir
  IFS=':' read -r -a path_dirs <<< "${PATH:-}"
  for path_dir in "${path_dirs[@]}"; do
    if [[ "$path_dir" == "$HOME"/* && -d "$path_dir" && -w "$path_dir" ]]; then
      case "$path_dir" in
        "$HOME/.local/bin"|"$HOME/.bun/bin"|"$HOME/bin")
          echo "$path_dir"
          return
          ;;
      esac
    fi
  done

  echo "${HOME}/.local/bin"
}

BIN_DIR="$(default_bin_dir)"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Gearbox installer needs '$1'." >&2
    exit 1
  fi
}

need curl
need node

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# Resolve version from GitHub Releases API.
if [[ "$VERSION" == "latest" ]]; then
  echo "-> Fetching latest release info"
  meta_file="${tmp}/release.json"
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" -o "$meta_file"
  resolved_version="$(grep '"tag_name"' "$meta_file" | head -1 | sed 's/.*"tag_name": *"v*\([^"]*\)".*/\1/')"
else
  resolved_version="${VERSION#v}"
fi

if [[ -z "$resolved_version" ]]; then
  echo "Could not determine release version." >&2
  exit 1
fi

target_dir="${INSTALL_ROOT}/${resolved_version}"
mkdir -p "$target_dir" "$BIN_DIR"

echo "-> Downloading gearbox v${resolved_version}"
curl -fsSL \
  "https://github.com/${REPO}/releases/download/v${resolved_version}/cli.mjs" \
  -o "${target_dir}/cli.mjs"
chmod 0755 "${target_dir}/cli.mjs"

# Replace any stale shim.
rm -f "${BIN_DIR}/gearbox"
cat > "${BIN_DIR}/gearbox" <<EOF
#!/usr/bin/env sh
exec node "${target_dir}/cli.mjs" "\$@"
EOF
chmod 0755 "${BIN_DIR}/gearbox"

echo ""
echo "Installed Gearbox v${resolved_version}"
echo "  ${BIN_DIR}/gearbox"
echo ""

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    echo "Run it with: gearbox"
    ;;
  *)
    shell_name="$(basename "${SHELL:-sh}")"
    rc_file="${HOME}/.profile"
    if [[ "$shell_name" == "zsh" ]]; then rc_file="${HOME}/.zshrc"; fi
    if [[ "$shell_name" == "bash" ]]; then rc_file="${HOME}/.bashrc"; fi
    echo "${BIN_DIR} is not on PATH yet. Add it:"
    echo "  echo 'export PATH=\"${BIN_DIR}:\$PATH\"' >> ${rc_file} && source ${rc_file}"
    echo ""
    echo "Then run: gearbox"
    ;;
esac

if [[ "${GEARBOX_SKIP_ONBOARD:-}" != "1" ]]; then
  echo ""
  echo "Starting setup..."
  if [[ -t 1 && -e /dev/tty && -r /dev/tty && -w /dev/tty ]]; then
    if ! "${BIN_DIR}/gearbox" onboard < /dev/tty > /dev/tty; then
      echo "Setup did not complete. Run: ${BIN_DIR}/gearbox onboard"
    fi
  else
    echo "No interactive terminal detected. Run: ${BIN_DIR}/gearbox onboard"
  fi
fi
