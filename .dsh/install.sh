#!/usr/bin/env sh
# Install the repository's DSH agent presets into a target machine's DSH user
# root, one directory per preset, exactly as the roster's discovery expects.
#
# The Git-tracked source lives in .dsh/agent-presets/<id>/; this script makes
# <target>/<id>/ on the current machine a fresh copy of it. Discovery is
# unmemoized and each generation keys off the composition file's stamp, so a
# NEW session on this machine picks up the installed copy without a restart;
# sessions already joined keep the generation they started on.
#
# Usage:
#   .dsh/install.sh                 # -> ${DSH_HOME:-$HOME/.dsh}/.agent-presets
#   .dsh/install.sh --target DIR    # install into DIR instead
#
# Idempotent: re-running replaces each preset directory wholesale. Only
# directories named by an existing source under .dsh/agent-presets/ are ever
# removed from the target; nothing else under the target is touched.

set -eu

SRC_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/agent-presets"
TARGET="${DSH_HOME:-$HOME/.dsh}/.agent-presets"

if [ "${1:-}" = "--target" ]; then
  [ "$#" -ge 2 ] || { echo "error: --target requires a directory" >&2; exit 2; }
  TARGET="$2"
fi

[ -d "$SRC_ROOT" ] || { echo "error: no presets under $SRC_ROOT" >&2; exit 2; }
mkdir -p "$TARGET"

installed=0
for src in "$SRC_ROOT"/*/; do
  [ -d "$src" ] || continue
  id="$(basename "$src")"
  # Preset ids follow [a-z0-9][a-z0-9-]*: reject empty, non-alnum/hyphen
  # characters, and a leading hyphen so the id is always a safe directory name.
  case "$id" in
    ""|*[!a-z0-9-]*|[!a-z0-9]*) echo "warning: skipping non-preset directory: $id" >&2; continue ;;
  esac
  rm -rf "$TARGET/$id"
  cp -R "$src" "$TARGET/$id"
  chmod -R u+rwX,go-rwx "$TARGET/$id"
  echo "installed $id -> $TARGET/$id"
  installed=$((installed + 1))
done

[ "$installed" -gt 0 ] || { echo "error: nothing to install under $SRC_ROOT" >&2; exit 2; }
echo "done: $installed preset(s). Start a new DSH session to use them."
