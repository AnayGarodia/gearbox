#!/usr/bin/env bash
# Public Gearbox installer.
#
# Installs the published npm package into user-owned directories:
#   ~/.local/share/gearbox/<version>/cli.mjs
#   first user-owned PATH bin dir containing gearbox, or ~/.local/bin/gearbox
#
# This intentionally avoids `npm install -g`, sudo, /usr/local, and any system
# prefix. It follows the same practical model as modern CLI installers: place a
# small executable shim in a user bin directory and tell the user if that
# directory is not on PATH.
set -euo pipefail

# ANSI helpers (no-op when stdout is not a TTY or NO_COLOR is set)
if [[ -t 1 && "${NO_COLOR:-}" == "" ]]; then
  R=$'\033[0m' B=$'\033[1m' D=$'\033[2m' C=$'\033[36m' G=$'\033[32m' Y=$'\033[33m'
else
  R='' B='' D='' C='' G='' Y=''
fi

PACKAGE_NAME="${GEARBOX_PACKAGE:-gearbox-code}"
VERSION="${GEARBOX_VERSION:-latest}"
INSTALL_ROOT="${GEARBOX_INSTALL_DIR:-${HOME}/.local/share/gearbox}"

default_bin_dir() {
  if [[ -n "${GEARBOX_BIN_DIR:-}" ]]; then
    echo "$GEARBOX_BIN_DIR"
    return
  fi

  # If an older user-owned gearbox shim is already first on PATH, replace it.
  # This fixes stale Bun/npm links such as ~/.bun/bin/gearbox -> src/cli.tsx,
  # which would otherwise keep shadowing the good ~/.local/bin installer shim.
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

printf "${D}  → fetching ${PACKAGE_NAME}@${VERSION}${R}\n"
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

printf "${D}  → downloading ${PACKAGE_NAME}@${resolved_version}${R}\n"
# Right after a publish, the registry metadata can resolve a version whose
# tarball hasn't replicated to the CDN edge yet (transient 404). Retry over
# ~30s before giving up. --retry-all-errors needs curl ≥7.71 (macOS 12+);
# older curls ignore unknown flags' behavior, so probe and degrade.
if curl --help all 2>/dev/null | grep -q -- --retry-all-errors; then
  curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors "$tarball_url" -o "$archive"
else
  curl -fsSL --retry 5 --retry-delay 5 "$tarball_url" -o "$archive"
fi
mkdir -p "$extract_dir" "$target_dir" "$BIN_DIR"
tar -xzf "$archive" -C "$extract_dir"

if [[ ! -f "${extract_dir}/package/dist/cli.mjs" ]]; then
  echo "Package did not contain dist/cli.mjs." >&2
  exit 1
fi

cp "${extract_dir}/package/dist/cli.mjs" "${target_dir}/cli.mjs"
chmod 0755 "${target_dir}/cli.mjs"

# Replace stale symlinks instead of following them. Old Bun-linked installs can
# leave ~/.bun/bin/gearbox -> .../src/cli.tsx; `cat > symlink` would overwrite
# the target and keep the broken link in place.
rm -f "${BIN_DIR}/gearbox"
cat > "${BIN_DIR}/gearbox" <<EOF
#!/usr/bin/env sh
exec node "${target_dir}/cli.mjs" "\$@"
EOF
chmod 0755 "${BIN_DIR}/gearbox"

printf "\n"
printf "${G}  ✓${R} ${B}gearbox ${resolved_version}${R} installed\n"
printf "${D}    ${BIN_DIR}/gearbox${R}\n"
printf "\n"

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    printf "  run ${C}gearbox${R} to start\n"
    ;;
  *)
    shell_name="$(basename "${SHELL:-sh}")"
    rc_file="${HOME}/.profile"
    if [[ "$shell_name" == "zsh" ]]; then rc_file="${HOME}/.zshrc"; fi
    if [[ "$shell_name" == "bash" ]]; then rc_file="${HOME}/.bashrc"; fi
    printf "${Y}  ! ${BIN_DIR} is not on PATH${R}\n"
    printf "    echo 'export PATH=\"${BIN_DIR}:\$PATH\"' >> ${rc_file}\n"
    printf "    source ${rc_file}\n"
    printf "\n"
    printf "  then run ${C}gearbox${R}\n"
    ;;
esac

if [[ "${GEARBOX_SKIP_ONBOARD:-}" != "1" ]]; then
  printf "\n"
  printf "${D}  setting up …${R}\n"
  if [[ -t 1 && -e /dev/tty && -r /dev/tty && -w /dev/tty ]]; then
    if ! "${BIN_DIR}/gearbox" onboard < /dev/tty > /dev/tty; then
      printf "${Y}  setup incomplete — run: ${C}gearbox onboard${R}\n"
    fi
  else
    printf "${D}  no interactive terminal — run: ${C}gearbox onboard${R}\n"
  fi
fi
