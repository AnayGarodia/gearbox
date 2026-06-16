#!/usr/bin/env bash
# Build and publish a GitHub release.
# Usage: bun run release
set -euo pipefail

REPO="AnayGarodia/gearbox"
VERSION="$(node -e "console.log(require('./package.json').version)")"
TAG="v${VERSION}"
NOTES="Install or update:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash
\`\`\`"

ASSETS=(
  "dist/cli.mjs"
  "dist/standalone/gearbox-darwin-arm64"
  "dist/standalone/gearbox-darwin-x64"
  "dist/standalone/gearbox-linux-x64"
  "dist/standalone/gearbox-linux-arm64"
)

die() {
  echo "release: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

asset_name() {
  basename "$1"
}

release_json() {
  gh release view "$TAG" --json assets,isDraft,tagName,url,uploadUrl "$@"
}

ensure_tag_points_at_head() {
  local head tag_head remote_tag
  head="$(git rev-parse HEAD)"
  tag_head="$(git rev-parse "$TAG^{commit}" 2>/dev/null || true)"
  [[ -n "$tag_head" ]] || die "local tag ${TAG} does not exist; tag the release commit first"
  [[ "$head" == "$tag_head" ]] || die "HEAD (${head}) is not ${TAG} (${tag_head})"

  remote_tag="$(git ls-remote --tags origin "$TAG" | awk '{print $1}' | head -1)"
  [[ -n "$remote_tag" ]] || die "origin is missing ${TAG}; push the tag before releasing"
  [[ "$remote_tag" == "$tag_head" ]] || die "origin/${TAG} (${remote_tag}) does not match local ${TAG} (${tag_head})"
}

build_assets() {
  echo "Building gearbox@${VERSION}..."
  bun run build

  echo "Compiling standalone binaries..."
  mkdir -p dist/standalone
  for target in bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64; do
    suffix="${target#bun-}"
    bun build --compile --target="$target" src/cli.tsx --outfile "dist/standalone/gearbox-${suffix}"
  done

  for path in "${ASSETS[@]}"; do
    [[ -s "$path" ]] || die "expected release asset is missing or empty: $path"
  done
}

ensure_draft_release() {
  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "Using existing release ${TAG}; uploads will clobber matching assets."
    return
  fi

  echo "Creating draft release ${TAG}..."
  gh release create "$TAG" \
    --draft \
    --verify-tag \
    --title "Gearbox ${TAG}" \
    --notes "$NOTES"
}

delete_asset_if_present() {
  local name="$1"
  gh release delete-asset "$TAG" "$name" -y >/dev/null 2>&1 || true
}

upload_asset() {
  local path="$1"
  local name token upload_url
  name="$(asset_name "$path")"
  token="$(gh auth token)"
  upload_url="$(release_json --jq '.uploadUrl' | sed 's/{.*//')"
  [[ -n "$upload_url" ]] || die "could not resolve upload URL for ${TAG}"

  echo "Uploading ${name} ($(du -h "$path" | awk '{print $1}'))..."
  delete_asset_if_present "$name"

  curl --fail-with-body --show-error --location \
    --retry 3 \
    --retry-all-errors \
    --retry-delay 5 \
    --connect-timeout 20 \
    --max-time 1800 \
    --request POST \
    --header "Authorization: Bearer ${token}" \
    --header "Accept: application/vnd.github+json" \
    --header "Content-Type: application/octet-stream" \
    --data-binary @"$path" \
    "${upload_url}?name=${name}" \
    >/dev/null
}

verify_assets() {
  local expected actual
  expected="$(printf '%s\n' "${ASSETS[@]}" | xargs -n1 basename | sort | tr '\n' ' ')"
  actual="$(release_json --jq '.assets[].name' | sort | tr '\n' ' ')"
  [[ "$actual" == "$expected" ]] || die "release assets mismatch; expected [${expected}], got [${actual}]"
}

publish_release() {
  local is_draft
  is_draft="$(release_json --jq '.isDraft')"
  if [[ "$is_draft" == "true" ]]; then
    echo "Publishing ${TAG}..."
    gh release edit "$TAG" --draft=false >/dev/null
  fi
}

main() {
  need bun
  need curl
  need gh
  need git
  gh auth status >/dev/null

  ensure_tag_points_at_head
  build_assets
  ensure_draft_release

  for path in "${ASSETS[@]}"; do
    upload_asset "$path"
  done

  verify_assets
  publish_release

  echo ""
  echo "Released gearbox ${TAG}"
  echo "Install: curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash"
}

main "$@"
