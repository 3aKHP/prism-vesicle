#!/bin/sh
# skillify publish wrapper — POSIX /bin/sh
#
# Usage:
#   publish_skill.sh validate <tmp/skillify/<name>>
#   publish_skill.sh publish  <tmp/skillify/<name>> <project|installed>
#
# Thin adapter: reconstructs the exact Vesicle CLI from Host-injected
# VESICLE_SELF_EXECUTABLE / VESICLE_SELF_ENTRYPOINT, invokes the non-model-
# visible skills validate|publish-draft JSON contract, and relays stdout and
# exit code unchanged. No path, hash, copy, staging, or cleanup logic lives here.

usage_error() {
  printf '%s\n' "$1" >&2
  exit 2
}

op="${1-}"
shift || true

case "$op" in
  validate)
    [ $# -eq 1 ] || usage_error "Usage: publish_skill.sh validate <tmp/skillify/<name>>"
    ;;
  publish)
    [ $# -eq 2 ] || usage_error "Usage: publish_skill.sh publish <tmp/skillify/<name>> <project|installed>"
    case "$2" in
      project|installed) ;;
      *) usage_error "Target must be 'project' or 'installed', got: $2" ;;
    esac
    ;;
  *)
    usage_error "Unknown operation '${op-}' (expected 'validate' or 'publish')"
    ;;
esac

# The Host injects VESICLE_SELF_EXECUTABLE (and VESICLE_SELF_ENTRYPOINT for
# source/npm runs). Never guess "vesicle" from PATH.
if [ -z "${VESICLE_SELF_EXECUTABLE:-}" ]; then
  printf '{"schema":"vesicle.skill-draft/v1","operation":"%s","ok":false,"source":"%s","diagnostics":[{"code":"publication-failed","message":"Vesicle self-invocation is not configured; the publisher must run through the Host runtime."}],"draftRetained":true,"currentSessionCatalogChanged":false,"catalogRefresh":"new-session-required"}\n' "$op" "$1"
  exit 1
fi

run_vesicle() {
  if [ -n "${VESICLE_SELF_ENTRYPOINT:-}" ]; then
    "$VESICLE_SELF_EXECUTABLE" "$VESICLE_SELF_ENTRYPOINT" "$@"
  else
    "$VESICLE_SELF_EXECUTABLE" "$@"
  fi
}

if [ "$op" = "validate" ]; then
  run_vesicle skills validate "$1" --draft --json
elif [ "$op" = "publish" ]; then
  # Validate quietly first. On failure the validation JSON and exit code pass
  # through unchanged. On success (--quiet-success) nothing is printed.
  run_vesicle skills validate "$1" --draft --json --quiet-success
  validate_rc=$?
  if [ "$validate_rc" -ne 0 ]; then
    exit "$validate_rc"
  fi
  run_vesicle skills publish-draft "$1" --target "$2" --json
fi
