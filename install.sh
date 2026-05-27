#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
PLUGIN_DIR="$HERMES_HOME/plugins/platforms/convos"
ENV_FILE="$HERMES_HOME/.env"

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

for item in plugin.yaml __init__.py adapter.py README.md; do
  cp -R "$ROOT_DIR/$item" "$PLUGIN_DIR/"
done

mkdir -p "$PLUGIN_DIR/sidecar"
for item in package.json package-lock.json tsconfig.json src dist; do
  cp -R "$ROOT_DIR/sidecar/$item" "$PLUGIN_DIR/sidecar/"
done

patch_macos_xmtp_bindings() {
  if [ "$(uname -s)" != "Darwin" ]; then
    return
  fi
  if ! command -v otool >/dev/null 2>&1 || ! command -v install_name_tool >/dev/null 2>&1; then
    return
  fi

  local libiconv=""
  for candidate in \
    "/opt/homebrew/opt/libiconv/lib/libiconv.2.dylib" \
    "/usr/local/opt/libiconv/lib/libiconv.2.dylib" \
    "/usr/lib/libiconv.2.dylib"; do
    if [ -f "$candidate" ]; then
      libiconv="$candidate"
      break
    fi
  done
  if [ -z "$libiconv" ]; then
    return
  fi

  while IFS= read -r -d '' binding; do
    local linked_iconv=""
    linked_iconv="$(otool -L "$binding" 2>/dev/null | awk '/\\/nix\\/store\\/.*libiconv\\.2\\.dylib/ {print $1; exit}')"
    if [ -z "$linked_iconv" ]; then
      continue
    fi
    echo "Patching XMTP macOS native binding: $binding"
    install_name_tool -change "$linked_iconv" "$libiconv" "$binding" || true
    if command -v codesign >/dev/null 2>&1; then
      codesign --force --sign - "$binding" >/dev/null 2>&1 || true
    fi
  done < <(find "$PLUGIN_DIR/sidecar/node_modules" -path '*@xmtp/node-bindings/dist/bindings_node.darwin-arm64.node' -print0 2>/dev/null)
}

echo "Installing sidecar runtime dependencies in $PLUGIN_DIR/sidecar..."
npm --prefix "$PLUGIN_DIR/sidecar" install --omit=dev
patch_macos_xmtp_bindings

echo "Enabling Hermes plugin platforms/convos..."
hermes plugins enable platforms/convos

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return
  fi
  node -e "console.log(require('crypto').randomBytes($bytes).toString('hex'))"
}

append_env_if_missing() {
  local key="$1"
  local value="$2"
  if [ -f "$ENV_FILE" ] && grep -q "^${key}=" "$ENV_FILE"; then
    echo "Keeping existing $key in $ENV_FILE"
    return
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  echo "Added $key to $ENV_FILE"
}

echo "Bootstrapping Convos environment in $ENV_FILE..."
mkdir -p "$HERMES_HOME"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true

append_env_if_missing "CONVOS_XMTP_WALLET_KEY" "0x$(random_hex 32)"
append_env_if_missing "CONVOS_XMTP_DB_ENCRYPTION_KEY" "$(random_hex 32)"
append_env_if_missing "CONVOS_XMTP_ENV" "production"
append_env_if_missing "CONVOS_AGENT_NAME" "Hermes Agent"
append_env_if_missing "CONVOS_GROUP_NAME" "Hermes Agent"

if ! grep -q '^CONVOS_ALLOWED_USERS=' "$ENV_FILE" && ! grep -q '^CONVOS_ALLOW_ALL_USERS=' "$ENV_FILE"; then
  append_env_if_missing "CONVOS_ALLOW_ALL_USERS" "true"
fi

cat <<EOF

Hermes Convos adapter installed.

Next:
1. Restart Hermes so it loads the Convos platform:
   hermes gateway

2. Open the invite URL from the gateway logs, or read:
   $HERMES_HOME/convos/info.json

For quick local testing, this installer sets CONVOS_ALLOW_ALL_USERS=true when
no allowlist exists. For a private agent, replace it with CONVOS_ALLOWED_USERS.

EOF
