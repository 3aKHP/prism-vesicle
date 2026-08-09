#!/bin/sh
# update-config wrapper — POSIX /bin/sh
#
# Usage:
#   update_config.sh <config-subcommand> [args...]
#
# Thin adapter: reconstructs the exact Vesicle CLI from Host-injected
# VESICLE_SELF_EXECUTABLE / VESICLE_SELF_ENTRYPOINT, invokes the non-model-
# visible `vesicle config` JSON contract, and relays stdout and exit code
# unchanged. No path, schema, validation, or write logic lives here.

if [ $# -lt 1 ]; then
  printf '%s\n' "Usage: update_config.sh <path|show|set|add-provider|env-set-empty|env-set-proxy|env-remove|validate> [args...]" >&2
  exit 2
fi

if [ -z "${VESICLE_SELF_EXECUTABLE:-}" ]; then
  printf '%s\n' '{"ok":false,"error":"Vesicle self-invocation is not configured; update-config must run through the Host runtime."}'
  exit 1
fi

if [ -n "${VESICLE_SELF_ENTRYPOINT:-}" ]; then
  "$VESICLE_SELF_EXECUTABLE" "$VESICLE_SELF_ENTRYPOINT" config "$@"
else
  "$VESICLE_SELF_EXECUTABLE" config "$@"
fi
