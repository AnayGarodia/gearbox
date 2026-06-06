#!/usr/bin/env bash
# Create a GitHub release and upload the built binary.
# Usage: bun run release
set -euo pipefail

VERSION="$(node -e "console.log(require('./package.json').version)")"
TAG="v${VERSION}"

echo "Building gearbox@${VERSION}..."
bun run build

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release ${TAG} already exists — uploading new cli.mjs..."
  gh release upload "$TAG" dist/cli.mjs --clobber
else
  echo "Creating GitHub release ${TAG}..."
  gh release create "$TAG" dist/cli.mjs \
    --title "Gearbox ${TAG}" \
    --notes "Install or update:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/AnayGarodia/gearbox/main/install.sh | bash
\`\`\`"
fi

echo ""
echo "Released gearbox ${TAG}"
echo "Install: curl -fsSL https://raw.githubusercontent.com/AnayGarodia/gearbox/main/install.sh | bash"
