#!/usr/bin/env bash
# Gearbox installer.
# Prefers the ~11MB JS bundle (cli.mjs) run via your existing Node/Bun — fast to
# download AND keeps credentials in the file store (no macOS Keychain password
# prompts). Falls back to the ~100MB self-contained binary only when no JS
# runtime is present. Both come from GitHub Releases (no npm CDN propagation lag).
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

# Restore the cursor + clear temp files however we exit (incl. Ctrl-C mid-spin).
TMP=""
cleanup() {
  [[ -n "${TMP:-}" ]] && rm -f "$TMP"
  [[ -t 1 ]] && printf '\033[?25h' 2>/dev/null || true   # restore cursor (TTY only)
}
trap cleanup EXIT INT

# spin "label" cmd… — braille spinner while cmd runs in the background, then a
# ✓ (or ✗) line. Plain single line when there's no TTY (NO_COLOR / piped).
spin() {
  local label="$1"; shift
  if [[ -z "$C" ]]; then
    printf "  %s\n" "$label"
    "$@"
    return $?
  fi
  "$@" &
  local pid=$! rc=0
  local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) i=0
  printf '\033[?25l'
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${C}%s${R} %s" "${frames[i]}" "$label"
    i=$(( (i + 1) % ${#frames[@]} ))
    sleep 0.08
  done
  wait "$pid" && rc=0 || rc=$?
  printf '\033[?25h'
  if [[ $rc -eq 0 ]]; then
    printf "\r  ${G}✓${R} %s\033[K\n" "$label"
  else
    printf "\r  ${Y}✗${R} %s\033[K\n" "$label"
  fi
  return $rc
}

have curl || fail "the installer needs curl" \
  "macOS ships it; Debian/Ubuntu: sudo apt install curl"

# ── Detect platform ──────────────────────────────────────────────────────────
OS=""; ARCH=""
case "$(uname -s)" in Darwin) OS="darwin" ;; Linux) OS="linux" ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH="arm64" ;; x86_64|amd64) ARCH="x64" ;; esac
[[ -n "$OS" ]]   || fail "unsupported OS: $(uname -s)"   "open an issue at https://github.com/${REPO}"
[[ -n "$ARCH" ]] || fail "unsupported arch: $(uname -m)" "open an issue at https://github.com/${REPO}"

# ── Header ───────────────────────────────────────────────────────────────────
ACTION="installing"; [[ -n "${GEARBOX_UPDATE:-}" ]] && ACTION="updating"
printf "\n  ${B}◆ Gearbox${R} ${D}· %s${R}\n\n" "$ACTION"

# ── Resolve download URL ─────────────────────────────────────────────────────
if [[ "$VERSION" == "latest" ]]; then
  REL="$(mktemp)"
  spin "Resolving latest release" \
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" -o "$REL" \
    || fail "couldn't reach GitHub" "check your connection or set GEARBOX_VERSION=v0.13.4"
  TAG="$(grep '"tag_name"' "$REL" | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  rm -f "$REL"
  [[ -n "$TAG" ]] || fail "couldn't determine latest release version" \
    "check https://github.com/${REPO}/releases or set GEARBOX_VERSION=v0.13.4"
else
  TAG="$VERSION"
fi

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

# ── Choose runtime ───────────────────────────────────────────────────────────
# Prefer Node, then Bun. The JS bundle runs on either and uses the file-based
# secret store (no Keychain). Only with no runtime do we pull the big binary.
RUNTIME=""
if have node; then RUNTIME="node"; elif have bun; then RUNTIME="bun"; fi

TMP="$(mktemp)"

if [[ -n "$RUNTIME" ]]; then
  # ── JS bundle path (fast · no Keychain prompts) ──────────────────────────────
  APP_DIR="${GEARBOX_HOME:-$HOME/.gearbox}/runtime"
  mkdir -p "$APP_DIR"
  CLI="${APP_DIR}/cli.mjs"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/cli.mjs"

  spin "Downloading ${TAG} ${D}(cli.mjs · ~12 MB · via ${RUNTIME})${R}" \
    curl -fsSL --retry 3 --retry-delay 3 "$DOWNLOAD_URL" -o "$TMP" \
    || fail "download failed: ${DOWNLOAD_URL}" \
         "check your connection or visit https://github.com/${REPO}/releases"

  mv "$TMP" "$CLI"
  # Shim that execs the bundle through the user's runtime (PATH-resolved, so it
  # survives node/bun version switches via nvm etc.).
  rm -f "${BIN_DIR}/gearbox"
  cat > "${BIN_DIR}/gearbox" <<EOF
#!/bin/sh
exec ${RUNTIME} "${CLI}" "\$@"
EOF
  chmod 0755 "${BIN_DIR}/gearbox"
else
  # ── Standalone binary fallback (no Node/Bun on this machine) ──────────────────
  BINARY_NAME="gearbox-${OS}-${ARCH}"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY_NAME}"

  spin "Downloading ${TAG} ${D}(${OS}/${ARCH} · standalone · ~100 MB)${R}" \
    curl -fsSL --retry 3 --retry-delay 3 "$DOWNLOAD_URL" -o "$TMP" \
    || fail "download failed: ${DOWNLOAD_URL}" \
         "check your connection or visit https://github.com/${REPO}/releases"

  rm -f "${BIN_DIR}/gearbox"
  mv "$TMP" "${BIN_DIR}/gearbox"
  chmod 0755 "${BIN_DIR}/gearbox"
fi

# ── Done ─────────────────────────────────────────────────────────────────────
if [[ -n "${GEARBOX_UPDATE:-}" ]]; then
  printf "\n  ${G}✓${R} ${B}updated to gearbox ${TAG}${R}\n"
  printf "  ${D}restart any running session to pick it up${R}\n\n"
  exit 0
fi

printf "\n  ${G}✓${R} ${B}gearbox ${TAG} installed${R}\n"
printf "  ${D}${BIN_DIR}/gearbox${R}\n\n"

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
