#!/usr/bin/env bash
# Gearbox internal install: makes the `gearbox` command available everywhere.
set -e
cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required. Install it with:"
  echo "  curl -fsSL https://bun.sh/install | bash"
  echo "then re-run ./install.sh"
  exit 1
fi

echo "→ Installing dependencies…"
bun install

echo "→ Linking the 'gearbox' command…"
bun link

echo ""
echo "✓ Done. 'gearbox' is installed (via ~/.bun/bin)."
echo ""
echo "Next:"
echo "  1) Set a provider key (each person uses their own):"
echo "       export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY"
echo "       export GOOGLE_GENERATIVE_AI_API_KEY=...   /   DEEPSEEK_API_KEY=..."
echo "     (add it to your ~/.zshrc to persist)"
echo "  2) Run it inside any project:   gearbox"
echo ""
if ! command -v gearbox >/dev/null 2>&1; then
  echo "⚠ 'gearbox' isn't on your PATH yet. Add Bun's bin dir:"
  echo "     echo 'export PATH=\"\$HOME/.bun/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
fi
