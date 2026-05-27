#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
PLUGIN_DIR="$HERMES_HOME/plugins/platforms/convos"

if ! command -v hermes >/dev/null 2>&1; then
  echo "hermes command not found. Install Hermes Agent first." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm command not found. Install Node.js and npm first." >&2
  exit 1
fi

echo "Building Convos sidecar..."
npm --prefix "$ROOT_DIR/sidecar" install
npm --prefix "$ROOT_DIR/sidecar" run build

echo "Installing plugin to $PLUGIN_DIR..."
mkdir -p "$(dirname "$PLUGIN_DIR")"
rm -rf "$PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"

for item in plugin.yaml __init__.py adapter.py sidecar README.md; do
  cp -R "$ROOT_DIR/$item" "$PLUGIN_DIR/"
done

echo "Enabling Hermes plugin platforms/convos..."
hermes plugins enable platforms/convos

cat <<EOF

Hermes Convos adapter installed.

Next:
1. Add CONVOS_XMTP_WALLET_KEY and related settings to:
   $HERMES_HOME/.env

2. Start Hermes:
   hermes gateway

3. Open the invite URL from the gateway logs, or read:
   $HERMES_HOME/convos/info.json

EOF
