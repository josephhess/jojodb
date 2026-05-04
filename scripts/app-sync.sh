#!/usr/bin/env bash
# app-sync — regenerate schema.ts from Postgres then rebuild the app binary.
# Usage: app-sync
# Alias set in ~/.zshrc

set -euo pipefail

JOJODB_DIR="$HOME/dev/tools/jojodb"

echo "→ generating schema.ts from database..."
cd "$JOJODB_DIR"
npm run generate-schema

echo "→ building jojodb binary..."
npm run tauri build -- --no-bundle

echo ""
echo "✓ app-sync complete. Binary at src-tauri/target/release/jojodb"
