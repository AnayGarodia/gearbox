#!/usr/bin/env bash
# Create a GitHub release and upload the built binary.
# Usage: bun run release
set -euo pipefail

VERSION="$(node -e "console.log(require('./package.json').version)")"
TAG="v${VERSION}"

echo "Building gearbox@${VERSION}..."
bun run build

# Standalone self-contained binaries (no Node/Bun needed on the target — the
# installer's fallback for machines with no JS runtime). Cross-compiled by Bun.
echo "Compiling standalone binaries..."
mkdir -p dist/standalone
for target in bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64; do
  suffix="${target#bun-}"
  bun build --compile --target="$target" src/cli.tsx --outfile "dist/standalone/gearbox-${suffix}"
done

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release ${TAG} already exists — uploading new cli.mjs..."
  gh release upload "$TAG" dist/cli.mjs dist/standalone/gearbox-* --clobber
else
  echo "Creating GitHub release ${TAG}..."
  gh release create "$TAG" dist/cli.mjs dist/standalone/gearbox-* \
    --title "Gearbox ${TAG}" \
    --notes "Install or update:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/AnayGarodia/gearbox/main/install.sh | bash
\`\`\`"
fi

echo ""
echo "Released gearbox ${TAG}"
echo "Install: curl -fsSL https://raw.githubusercontent.com/AnayGarodia/gearbox/main/install.sh | bash"
