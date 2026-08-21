#!/usr/bin/env bash
# ORDERLY front door — start wrapper.
#
# Its only job is credential wiring, and it has two ways to do it.
#
# 1. If the unit already put OPENCLAW_GATEWAY_TOKEN in the environment, that
#    wins and this script does nothing. That is the SPLIT-IDENTITY case: the
#    front door does not share the gateway's account, cannot read its 0600
#    ~/.openclaw/.env, and would only gain the Telegram bot token alongside the
#    bearer if it could. Root provisions the one variable into a root-owned
#    0600 file and systemd's EnvironmentFile= injects it before privileges are
#    dropped, so this identity is granted no read of a token file anywhere.
#
# 2. Otherwise — the shared-identity case — lift EXACTLY ONE variable out of
#    ~/.openclaw/.env, the same way the gateway's own start script does. No
#    blanket sourcing, so TELEGRAM_BOT_TOKEN stays behind.
#
# Either way the value is never written to disk, echoed, or logged; it exists
# only in this process's environment and its child's.
#
# The front door degrades honestly without it: /api/chat answers 503 with an
# explanation and the page disables its composer rather than failing silently.
#
# Set by the systemd unit:
#   ORDERLY_WEB_NODE  absolute path to node
#   ORDERLY_WEB_DIR   install directory holding server.mjs

set -euo pipefail

OPENCLAW_ENV="${OPENCLAW_ENV:-$HOME/.openclaw/.env}"
NODE_BIN="${ORDERLY_WEB_NODE:-$(command -v node || true)}"
APP_DIR="${ORDERLY_WEB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

if [ -z "$NODE_BIN" ]; then
  echo "FATAL: no node binary — set ORDERLY_WEB_NODE." >&2
  exit 1
fi

if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  # Already supplied by the unit. Do not read a file, do not overwrite it.
  export OPENCLAW_GATEWAY_TOKEN
elif [ -r "$OPENCLAW_ENV" ]; then
  # Extract exactly one variable. Tolerates an optional `export` and quotes.
  OPENCLAW_GATEWAY_TOKEN="$(
    sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}OPENCLAW_GATEWAY_TOKEN=["'"'"']\{0,1\}\([^"'"'"']*\)["'"'"']\{0,1\}[[:space:]]*$/\2/p' "$OPENCLAW_ENV" | tail -n 1
  )"
  if [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
    export OPENCLAW_GATEWAY_TOKEN
  else
    echo "warning: OPENCLAW_GATEWAY_TOKEN not found in $OPENCLAW_ENV — chat will be off." >&2
  fi
else
  echo "warning: $OPENCLAW_ENV not readable — chat will be off." >&2
fi

exec "$NODE_BIN" "$APP_DIR/server.mjs"
