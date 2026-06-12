#!/usr/bin/env bash
# Gearbox installer — downloads the prebuilt binary from GitHub Releases.
# Usage: curl -fsSL https://raw.githubusercontent.com/AnayGarodia/gearbox/main/install.sh | bash
set -euo pipefail

REPO="AnayGarodia/gearbox"
VERSION="${GEARBOX_VERSION:-latest}"

# ANSI helpers (no-op when not a TTY or NO_COLOR is set)
if [[ -t 1 && "${NO_COLOR:-}" == "" ]]; then
  R=$'\033[0m' B=$'\033[1m' D=$'\033[2m' C=$'\033[36m' G=$'\033[32m' Y=$'\033[33m'
else
  R='' B='' D='' C='' G='' Y=''
fi

have() { command -v "$1" >/dev/null 2>&1; }

fail() {
  printf "\n${Y}  ✗ %s${R}\n" "$1" >&2
  shift
  for line in "$@"; do printf "    %s\n" "$line" >&2; done
  printf "\n" >&2
  exit 1
}

have curl || fail "the installer needs curl" \
  "macOS ships it; Debian/Ubuntu: sudo apt install curl"

# ── Detect platform ──────────────────────────────────────────────────────────
OS=""; ARCH=""
case "$(uname -s)" in Darwin) OS="darwin" ;; Linux) OS="linux" ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH="arm64" ;; x86_64|amd64) ARCH="x64" ;; esac
[[ -n "$OS" ]]   || fail "unsupported OS: $(uname -s)"   "open an issue at https://github.com/${REPO}"
[[ -n "$ARCH" ]] || fail "unsupported arch: $(uname -m)" "open an issue at https://github.com/${REPO}"

# ── Resolve download URL ─────────────────────────────────────────────────────
if [[ "$VERSION" == "latest" ]]; then
  printf "${D}  → resolving latest release${R}\n"
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"
  TAG="$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  [[ -n "$TAG" ]] || fail "couldn't determine latest release version" \
    "check https://github.com/${REPO}/releases or set GEARBOX_VERSION=v0.12.2"
else
  TAG="$VERSION"
fi

BINARY_NAME="gearbox-${OS}-${ARCH}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY_NAME}"

# ── Pick install directory ───────────────────────────────────────────────────
default_bin_dir() {
  if [[ -n "${GEARBOX_BIN_DIR:-}" ]]; then echo "$GEARBOX_BIN_DIR"; return; fi
  # Replace an existing user-owned gearbox shim in place.
  local existing dir
  existing="$(command -v gearbox 2>/dev/null || true)"
  if [[ -n "$existing" ]]; then
    dir="$(dirname "$existing")"
    if [[ "$dir" == "$HOME"/* && -d "$dir" && -w "$dir" ]]; then
      echo "$dir"; return
    fi
  fi
  # Prefer well-known user bin dirs already on PATH.
  local path_dir
  IFS=':' read -r -a path_dirs <<< "${PATH:-}"
  for path_dir in "${path_dirs[@]}"; do
    if [[ "$path_dir" == "$HOME"/* && -d "$path_dir" && -w "$path_dir" ]]; then
      case "$path_dir" in
        "$HOME/.local/bin"|"$HOME/.bun/bin"|"$HOME/bin")
          echo "$path_dir"; return;;
      esac
    fi
  done
  echo "${HOME}/.local/bin"
}

BIN_DIR="$(default_bin_dir)"
mkdir -p "$BIN_DIR"

# ── Download ─────────────────────────────────────────────────────────────────
printf "${D}  → downloading gearbox ${TAG} (${OS}/${ARCH})${R}\n"
TMP="$(mktemp)"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

if ! curl -fL --retry 3 --retry-delay 3 --progress-bar "$DOWNLOAD_URL" -o "$TMP"; then
  fail "download failed: ${DOWNLOAD_URL}" \
    "check your connection or visit https://github.com/${REPO}/releases"
fi

# ── Install ──────────────────────────────────────────────────────────────────
rm -f "${BIN_DIR}/gearbox"
mv "$TMP" "${BIN_DIR}/gearbox"
chmod 0755 "${BIN_DIR}/gearbox"

printf "\n${G}  ✓${R} ${B}gearbox ${TAG}${R} installed\n"
printf "${D}    ${BIN_DIR}/gearbox${R}\n\n"

# ── PATH hint ────────────────────────────────────────────────────────────────
case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    printf "  run ${C}gearbox${R} to start\n"
    ;;
  *)
    shell_name="$(basename "${SHELL:-sh}")"
    rc_file="${HOME}/.profile"
    if [[ "$shell_name" == "zsh" ]];  then rc_file="${HOME}/.zshrc";  fi
    if [[ "$shell_name" == "bash" ]]; then rc_file="${HOME}/.bashrc"; fi
    printf "${Y}  ! ${BIN_DIR} is not on PATH${R}\n"
    printf "    echo 'export PATH=\"${BIN_DIR}:\$PATH\"' >> %s && source %s\n" "$rc_file" "$rc_file"
    printf "\n  then run ${C}gearbox${R}\n"
    ;;
esac

# ── First-run onboarding ─────────────────────────────────────────────────────
if [[ "${GEARBOX_SKIP_ONBOARD:-}" != "1" ]]; then
  printf "\n${D}  setting up …${R}\n"
  if [[ -t 1 && -e /dev/tty && -r /dev/tty && -w /dev/tty ]]; then
    if ! "${BIN_DIR}/gearbox" onboard < /dev/tty > /dev/tty; then
      printf "${Y}  setup incomplete — run: ${C}gearbox onboard${R}\n"
    fi
  else
    printf "${D}  no interactive terminal — run: ${C}gearbox onboard${R}\n"
  fi
fi
