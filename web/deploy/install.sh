#!/usr/bin/env bash
# Install the ORDERLY front door on the gateway host.
#
# It runs as its own systemd unit on its own loopback port. It never touches the
# gateway's config or process, so installing or upgrading it cannot interrupt
# Telegram or the mail agent.
#
# Usage (from a checkout of this repo, on the gateway host):
#   bash web/deploy/install.sh [--dry-run]

set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: $0 [--dry-run]" >&2; exit 2; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="${ORDERLY_WEB_UNIT:-/etc/systemd/system/orderly-web.service}"
TEMPLATE="$SRC/deploy/orderly-web.service"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/orderly-web-install.XXXXXX")"
PROPOSED_UNIT="$TMP_DIR/orderly-web.service"
trap 'rm -rf "$TMP_DIR"' EXIT

# Remember which values the operator supplied; empty is still an override.
WEB_PORT_SET="${ORDERLY_WEB_PORT+x}"
GATEWAY_PORT_SET="${ORDERLY_GATEWAY_PORT+x}"
NODE_SET="${ORDERLY_WEB_NODE+x}"
WEB_DIR_SET="${ORDERLY_WEB_DIR+x}"
DOCS_SET="${ORDERLY_OPENCLAW_DOCS+x}"
ENV_FILES_SET="${ORDERLY_ENV_FILES+x}"
BROKER_SOCKET_SET="${ORDERLY_BROKER_SOCKET+x}"
CALENDAR_SOCKET_SET="${ORDERLY_CALENDAR_SOCKET+x}"
AGENT_RUNTIME_SOCKET_SET="${ORDERLY_AGENT_RUNTIME_SOCKET+x}"
CONNECTORS_CONFIG_SET="${ORDERLY_CONNECTORS_CONFIG+x}"
REPLY_STYLE_CONFIG_SET="${ORDERLY_REPLY_STYLE_CONFIG+x}"

unit_directive() {
  awk -F= -v name="$1" '
    $0 ~ "^[[:space:]]*" name "=" {
      sub("^[[:space:]]*" name "=", "")
      print
      exit
    }
  ' "$2"
}

unit_environment() {
  awk -v name="$1" '
    $0 ~ "^[[:space:]]*Environment=\"?" name "=" {
      line=$0
      sub("^[[:space:]]*Environment=\"?" name "=", "", line)
      sub(/["][[:space:]]*$/, "", line)
      print line
      exit
    }
  ' "$2"
}

set_unit_environment() {
  name="$1"
  value="$2"
  omit="$3"
  next="$TMP_DIR/unit.next"
  awk -v name="$name" -v value="$value" -v omit="$omit" '
    BEGIN { in_service=0; found=0; inserted=0 }
    /^\[Service\][[:space:]]*$/ { in_service=1 }
    /^\[/ && $0 !~ /^\[Service\][[:space:]]*$/ {
      if (in_service && !found && !inserted && !omit) {
        print "Environment=" name "=" value
        inserted=1
      }
      in_service=0
    }
    in_service && $0 ~ "^[[:space:]]*Environment=\"?" name "=" {
      found=1
      if (!omit) print "Environment=" name "=" value
      next
    }
    in_service && !found && !inserted && !omit &&
      $0 ~ /^[[:space:]]*(EnvironmentFile|ExecStart)=/ {
      print "Environment=" name "=" value
      inserted=1
    }
    { print }
    END {
      if (in_service && !found && !inserted && !omit)
        print "Environment=" name "=" value
    }
  ' "$PROPOSED_UNIT" > "$next"
  mv "$next" "$PROPOSED_UNIT"
}

set_exec_start() {
  value="$1"
  next="$TMP_DIR/unit.next"
  awk -v value="$value" '
    BEGIN { in_service=0; found=0 }
    /^\[Service\][[:space:]]*$/ { in_service=1 }
    /^\[/ && $0 !~ /^\[Service\][[:space:]]*$/ {
      if (in_service && !found) {
        print "ExecStart=" value
        found=1
      }
      in_service=0
    }
    in_service && /^[[:space:]]*ExecStart=/ {
      if (!found) print "ExecStart=" value
      found=1
      next
    }
    { print }
    END {
      if (in_service && !found) print "ExecStart=" value
    }
  ' "$PROPOSED_UNIT" > "$next"
  mv "$next" "$PROPOSED_UNIT"
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

print_root_command() {
  if [ "$(id -u)" -ne 0 ]; then
    printf ' sudo'
  fi
  printf ' %q' "$@"
  printf '\n'
}

readable_as_service() {
  path="$1"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    return 1
  fi
  if [ "$(id -un)" = "$SERVICE_USER" ]; then
    [ -r "$path" ] && [ -x "$path" ]
  elif [ "$(id -u)" -eq 0 ] && command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- sh -c 'test -r "$1" && test -x "$1"' sh "$path"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -n -u "$SERVICE_USER" sh -c 'test -r "$1" && test -x "$1"' sh "$path" \
      >/dev/null 2>&1
  else
    return 1
  fi
}

UNIT_EXISTS=0
if [ -f "$UNIT" ]; then
  UNIT_EXISTS=1
  cp "$UNIT" "$PROPOSED_UNIT"
else
  cp "$TEMPLATE" "$PROPOSED_UNIT"
fi

SERVICE_USER="$(unit_directive User "$PROPOSED_UNIT")"
SERVICE_USER="${SERVICE_USER:-root}"

if [ "$WEB_DIR_SET" = x ]; then
  DEST="$ORDERLY_WEB_DIR"
else
  DEST="$(unit_environment ORDERLY_WEB_DIR "$PROPOSED_UNIT")"
  DEST="${DEST:-/var/lib/orderly-web}"
fi
[ -n "$DEST" ] || { echo "ORDERLY_WEB_DIR must not be empty." >&2; exit 1; }
case "$DEST" in
  /*) ;;
  *) echo "ORDERLY_WEB_DIR must be an absolute path: $DEST" >&2; exit 1 ;;
esac
[ "$DEST" != / ] || { echo "ORDERLY_WEB_DIR must not be /." >&2; exit 1; }

if [ "$UNIT_EXISTS" -eq 0 ]; then
  if [ "$NODE_SET" = x ]; then
    NODE="$ORDERLY_WEB_NODE"
  else
    NODE="$(command -v node || true)"
  fi
  if [ -z "$NODE" ]; then
    echo "node not found on PATH; set ORDERLY_WEB_NODE." >&2
    exit 1
  fi

  if [ "$WEB_PORT_SET" = x ]; then
    WEB_PORT="$ORDERLY_WEB_PORT"
  else
    WEB_PORT="$(unit_environment ORDERLY_WEB_PORT "$PROPOSED_UNIT")"
  fi
  if [ "$GATEWAY_PORT_SET" = x ]; then
    GATEWAY_PORT="$ORDERLY_GATEWAY_PORT"
  else
    GATEWAY_PORT="$(unit_environment ORDERLY_GATEWAY_PORT "$PROPOSED_UNIT")"
  fi
  if [ "$ENV_FILES_SET" = x ]; then
    ENV_FILES="$ORDERLY_ENV_FILES"
  else
    ENV_FILES="$(unit_environment ORDERLY_ENV_FILES "$PROPOSED_UNIT")"
  fi
  if [ "$BROKER_SOCKET_SET" = x ]; then
    BROKER_SOCKET="$ORDERLY_BROKER_SOCKET"
  else
    BROKER_SOCKET="$(unit_environment ORDERLY_BROKER_SOCKET "$PROPOSED_UNIT")"
  fi
  if [ "$CALENDAR_SOCKET_SET" = x ]; then
    CALENDAR_SOCKET="$ORDERLY_CALENDAR_SOCKET"
  else
    CALENDAR_SOCKET="$(unit_environment ORDERLY_CALENDAR_SOCKET "$PROPOSED_UNIT")"
  fi

  DOCS=""
  if [ "$DOCS_SET" = x ]; then
    DOCS="$ORDERLY_OPENCLAW_DOCS"
  else
    for candidate in \
      "$(npm root -g 2>/dev/null || true)/openclaw/docs/providers" \
      "$HOME/.local/share/fnm/current/lib/node_modules/openclaw/docs/providers"; do
      if [ -d "$candidate" ] && readable_as_service "$candidate"; then
        DOCS="$candidate"
        break
      fi
    done
  fi
  if [ -n "$DOCS" ] && ! readable_as_service "$DOCS"; then
    echo "warning: provider docs not readable as $SERVICE_USER: $DOCS" >&2
    DOCS=""
  fi
  if [ -z "$DOCS" ]; then
    echo "warning: omitting ORDERLY_OPENCLAW_DOCS; settings will use its fallback table." >&2
  fi

  set_unit_environment ORDERLY_WEB_PORT "$WEB_PORT" 0
  set_unit_environment ORDERLY_GATEWAY_PORT "$GATEWAY_PORT" 0
  set_unit_environment ORDERLY_WEB_NODE "$NODE" 0
  set_unit_environment ORDERLY_WEB_DIR "$DEST" 0
  if [ -n "$DOCS" ]; then
    set_unit_environment ORDERLY_OPENCLAW_DOCS "$DOCS" 0
  else
    set_unit_environment ORDERLY_OPENCLAW_DOCS "" 1
  fi
  set_unit_environment ORDERLY_ENV_FILES "$ENV_FILES" 0
  set_unit_environment ORDERLY_BROKER_SOCKET "$BROKER_SOCKET" 0
  set_unit_environment ORDERLY_CALENDAR_SOCKET "$CALENDAR_SOCKET" 0
  set_exec_start "$DEST/start-web.sh"
else
  # Existing units are authoritative; only explicit environment overrides move.
  if [ "$WEB_PORT_SET" = x ]; then
    set_unit_environment ORDERLY_WEB_PORT "$ORDERLY_WEB_PORT" 0
  fi
  if [ "$GATEWAY_PORT_SET" = x ]; then
    set_unit_environment ORDERLY_GATEWAY_PORT "$ORDERLY_GATEWAY_PORT" 0
  fi
  if [ "$NODE_SET" = x ]; then
    [ -n "$ORDERLY_WEB_NODE" ] || { echo "ORDERLY_WEB_NODE must not be empty." >&2; exit 1; }
    set_unit_environment ORDERLY_WEB_NODE "$ORDERLY_WEB_NODE" 0
  fi
  if [ "$WEB_DIR_SET" = x ]; then
    set_unit_environment ORDERLY_WEB_DIR "$DEST" 0
    set_exec_start "$DEST/start-web.sh"
  fi
  if [ "$DOCS_SET" = x ]; then
    if [ -n "$ORDERLY_OPENCLAW_DOCS" ] && readable_as_service "$ORDERLY_OPENCLAW_DOCS"; then
      set_unit_environment ORDERLY_OPENCLAW_DOCS "$ORDERLY_OPENCLAW_DOCS" 0
    else
      if [ -n "$ORDERLY_OPENCLAW_DOCS" ]; then
        echo "warning: provider docs not readable as $SERVICE_USER: $ORDERLY_OPENCLAW_DOCS" >&2
      fi
      echo "warning: omitting ORDERLY_OPENCLAW_DOCS; settings will use its fallback table." >&2
      set_unit_environment ORDERLY_OPENCLAW_DOCS "" 1
    fi
  fi
  if [ "$ENV_FILES_SET" = x ]; then
    set_unit_environment ORDERLY_ENV_FILES "$ORDERLY_ENV_FILES" 0
  fi
  if [ "$BROKER_SOCKET_SET" = x ]; then
    set_unit_environment ORDERLY_BROKER_SOCKET "$ORDERLY_BROKER_SOCKET" 0
  fi
  if [ "$CALENDAR_SOCKET_SET" = x ]; then
    set_unit_environment ORDERLY_CALENDAR_SOCKET "$ORDERLY_CALENDAR_SOCKET" 0
  fi
fi

if [ "$AGENT_RUNTIME_SOCKET_SET" = x ]; then
  AGENT_RUNTIME_SOCKET="$ORDERLY_AGENT_RUNTIME_SOCKET"
else
  AGENT_RUNTIME_SOCKET="$(unit_environment ORDERLY_AGENT_RUNTIME_SOCKET "$PROPOSED_UNIT")"
  AGENT_RUNTIME_SOCKET="${AGENT_RUNTIME_SOCKET:-/run/orderly-agents/runtime.sock}"
fi
case "$AGENT_RUNTIME_SOCKET" in /*) ;; *) echo "ORDERLY_AGENT_RUNTIME_SOCKET must be absolute." >&2; exit 1 ;; esac
set_unit_environment ORDERLY_AGENT_RUNTIME_SOCKET "$AGENT_RUNTIME_SOCKET" 0
# v0.4 owned this tree in the web service. v0.4.1 deliberately removes the
# variable even on an in-place unit upgrade; the rollback copy stays on disk.
set_unit_environment ORDERLY_AGENTS_ROOT "" 1

if [ "$CONNECTORS_CONFIG_SET" = x ]; then
  CONNECTORS_CONFIG="$ORDERLY_CONNECTORS_CONFIG"
else
  CONNECTORS_CONFIG="$(unit_environment ORDERLY_CONNECTORS_CONFIG "$PROPOSED_UNIT")"
  CONNECTORS_CONFIG="${CONNECTORS_CONFIG:-$DEST/.orderly/connectors.json}"
fi
if [ "$REPLY_STYLE_CONFIG_SET" = x ]; then
  REPLY_STYLE_CONFIG="$ORDERLY_REPLY_STYLE_CONFIG"
else
  REPLY_STYLE_CONFIG="$(unit_environment ORDERLY_REPLY_STYLE_CONFIG "$PROPOSED_UNIT")"
  REPLY_STYLE_CONFIG="${REPLY_STYLE_CONFIG:-$DEST/.orderly/reply-style.json}"
fi
case "$CONNECTORS_CONFIG" in /*) ;; *) echo "ORDERLY_CONNECTORS_CONFIG must be absolute." >&2; exit 1 ;; esac
case "$REPLY_STYLE_CONFIG" in /*) ;; *) echo "ORDERLY_REPLY_STYLE_CONFIG must be absolute." >&2; exit 1 ;; esac
set_unit_environment ORDERLY_CONNECTORS_CONFIG "$CONNECTORS_CONFIG" 0
set_unit_environment ORDERLY_REPLY_STYLE_CONFIG "$REPLY_STYLE_CONFIG" 0

APP_FILES="server.mjs settings.mjs queue.mjs calendar.mjs dashboard.mjs agents.mjs agent-runtime-client.mjs engines.mjs reply-style.mjs connectors.mjs"
CONNECTOR_FILES="catalog.mjs control.mjs connectorctl.mjs client.mjs service.mjs probes.mjs runtime.mjs"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry run: installing from $SRC -> $DEST"
  echo "service user: $SERVICE_USER"
  echo "unit diff:"
  if [ "$UNIT_EXISTS" -eq 1 ]; then
    if cmp -s "$UNIT" "$PROPOSED_UNIT"; then
      echo "  (no unit changes)"
    else
      diff -u "$UNIT" "$PROPOSED_UNIT" || [ "$?" -eq 1 ]
    fi
  else
    diff -u /dev/null "$PROPOSED_UNIT" || [ "$?" -eq 1 ]
  fi
  echo "file operations:"
  print_root_command mkdir -p "$DEST"
  for file in $APP_FILES; do
    print_root_command install -m 0644 "$SRC/$file" "$DEST/$file"
  done
  print_root_command mkdir -p "$DEST/connectors"
  for file in $CONNECTOR_FILES; do
    print_root_command install -m 0644 "$SRC/../connectors/$file" "$DEST/connectors/$file"
  done
  print_root_command install -m 0755 "$SRC/deploy/start-web.sh" "$DEST/start-web.sh"
  print_root_command rm -rf "$DEST/public"
  print_root_command cp -R "$SRC/public" "$DEST/public"
  if ! cmp -s "$UNIT" "$PROPOSED_UNIT" 2>/dev/null; then
    print_root_command install -m 0644 "$PROPOSED_UNIT" "$UNIT"
  fi
  echo "ownership:"
  print_root_command chown "$SERVICE_USER" "$DEST"
  for file in $APP_FILES start-web.sh; do
    print_root_command chown "$SERVICE_USER" "$DEST/$file"
  done
  print_root_command chown -R "$SERVICE_USER" "$DEST/connectors"
  print_root_command chown -R "$SERVICE_USER" "$DEST/public"
  echo "service operations:"
  print_root_command systemctl daemon-reload
  print_root_command systemctl enable orderly-web.service
  print_root_command systemctl restart orderly-web.service
  exit 0
fi

echo "installing from $SRC -> $DEST"
run_as_root mkdir -p "$DEST"
for file in $APP_FILES; do
  run_as_root install -m 0644 "$SRC/$file" "$DEST/$file"
done
run_as_root mkdir -p "$DEST/connectors"
for file in $CONNECTOR_FILES; do
  run_as_root install -m 0644 "$SRC/../connectors/$file" "$DEST/connectors/$file"
done
run_as_root install -m 0755 "$SRC/deploy/start-web.sh" "$DEST/start-web.sh"
run_as_root rm -rf "$DEST/public"
run_as_root cp -R "$SRC/public" "$DEST/public"

run_as_root chown "$SERVICE_USER" "$DEST"
for file in $APP_FILES start-web.sh; do
  run_as_root chown "$SERVICE_USER" "$DEST/$file"
done
run_as_root chown -R "$SERVICE_USER" "$DEST/connectors"
run_as_root chown -R "$SERVICE_USER" "$DEST/public"

if ! cmp -s "$UNIT" "$PROPOSED_UNIT" 2>/dev/null; then
  run_as_root install -m 0644 "$PROPOSED_UNIT" "$UNIT"
  echo "unit updated: $UNIT"
else
  echo "unit preserved: $UNIT"
fi

run_as_root systemctl daemon-reload
run_as_root systemctl enable orderly-web.service
# Restart, not just start: an upgrade has to pick up the new server and unit.
# Only this unit is touched — the gateway is never signalled.
run_as_root systemctl restart orderly-web.service
sleep 1
systemctl is-active orderly-web.service

echo
WEB_PORT="$(unit_environment ORDERLY_WEB_PORT "$PROPOSED_UNIT")"
echo "front door: http://127.0.0.1:${WEB_PORT:-18790}"
echo "gateway was not touched:"
systemctl is-active orderly-gateway.service
