#!/usr/bin/env bash
# Public Gearbox installer.
#
# Installs the published npm package into user-owned directories:
#   ~/.local/share/gearbox/<version>/cli.mjs
#   ~/.local/bin/gearbox
#
# This intentionally avoids `npm install -g`, sudo, /usr/local, and any system
# prefix. It follows the same practical model as modern CLI installers: place a
# small executable shim in a user bin directory and tell the user if that
# directory is not on PATH.
set -euo pipefail

PACKAGE_NAME="${GEARBOX_PACKAGE:-gearbox-code}"
VERSION="${GEARBOX_VERSION:-latest}"
BIN_DIR="${GEARBOX_BIN_DIR:-${HOME}/.local/bin}"
INSTALL_ROOT="${GEARBOX_INSTALL_DIR:-${HOME}/.local/share/gearbox}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Gearbox installer needs '$1'." >&2
    echo "Install Node.js first, then rerun this installer." >&2
    exit 1
  fi
}

need node
need curl
need tar

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

meta_url="https://registry.npmjs.org/${PACKAGE_NAME}/${VERSION}"
meta_file="${tmp}/meta.json"

echo "-> Fetching ${PACKAGE_NAME}@${VERSION}"
curl -fsSL "$meta_url" -o "$meta_file"

resolved_version="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(j.version || "")' "$meta_file")"
tarball_url="$(node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(j.dist && j.dist.tarball || "")' "$meta_file")"

if [[ -z "$resolved_version" || -z "$tarball_url" ]]; then
  echo "Could not resolve ${PACKAGE_NAME}@${VERSION} from npm." >&2
  exit 1
fi

target_dir="${INSTALL_ROOT}/${resolved_version}"
archive="${tmp}/package.tgz"
extract_dir="${tmp}/extract"

echo "-> Downloading ${PACKAGE_NAME}@${resolved_version}"
curl -fsSL "$tarball_url" -o "$archive"
mkdir -p "$extract_dir" "$target_dir" "$BIN_DIR"
tar -xzf "$archive" -C "$extract_dir"

if [[ ! -f "${extract_dir}/package/dist/cli.mjs" ]]; then
  echo "Package did not contain dist/cli.mjs." >&2
  exit 1
fi

cp "${extract_dir}/package/dist/cli.mjs" "${target_dir}/cli.mjs"
chmod 0755 "${target_dir}/cli.mjs"

cat > "${BIN_DIR}/gearbox" <<EOF
#!/usr/bin/env sh
exec node "${target_dir}/cli.mjs" "\$@"
EOF
chmod 0755 "${BIN_DIR}/gearbox"

echo ""
echo "Installed Gearbox ${resolved_version}"
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
    echo "${BIN_DIR} is not on PATH yet."
    echo "Add it with:"
    echo "  echo 'export PATH=\"${BIN_DIR}:\$PATH\"' >> ${rc_file}"
    echo "  source ${rc_file}"
    echo ""
    echo "Then run: gearbox"
    ;;
esac

if [[ "${GEARBOX_SKIP_ONBOARD:-}" != "1" ]]; then
  echo ""
  echo "Starting setup..."
  if [[ -r /dev/tty && -w /dev/tty ]]; then
    "${BIN_DIR}/gearbox" onboard < /dev/tty > /dev/tty
  else
    echo "No interactive terminal detected. Run: ${BIN_DIR}/gearbox onboard"
  fi
fi
