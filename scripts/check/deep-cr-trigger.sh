#!/usr/bin/env bash
# deep-cr-trigger.sh — deterministic, read-only gate for the Tier 2 deep-cr review.
#
# Prints a single JSON object {"trigger":bool,"reasons":[...]} and exits 0.
# Never modifies state. The rule mirrors docs/dev/WORKFLOW.md "Rapid Development
# Exception" high-risk list:
#
#   trigger = RUST_CHANGE || (CATEGORY_MATCH && (CROSS_BOUNDARY || SIZE_FLOOR || RELEASE_BRANCH))
#
# Usage: scripts/check/deep-cr-trigger.sh [base]    (base defaults to "develop")
set -u

base="${1:-develop}"

# ---- collect the committed changed file set ---------------------------------
mb=""
committed_ok=1
mb_out=$(git merge-base HEAD "$base" 2>/dev/null) || committed_ok=0
if [ "$committed_ok" -eq 1 ] && [ -n "$mb_out" ]; then
  mb="$mb_out"
fi

# The gate and finders evaluate committed branch diffs only. Read NUL-delimited
# paths so Git quoting and embedded newlines cannot hide a Rust/build suffix.
changed_files=()
# Disable rename collapsing so moving code out of a guarded path still reviews
# its old domain, and renaming Rust to another suffix cannot evade the gate.
if [ -n "$mb" ]; then
  while IFS= read -r -d '' file; do changed_files+=("$file"); done \
    < <(git diff --no-renames --name-only -z "$mb" HEAD 2>/dev/null)
fi
file_count=${#changed_files[@]}

# ---- map a path to its high-risk domain category (or empty) ------------------
# Mirrors LENSES[].prefixes in .claude/workflows/deep-cr.js and the list in
# docs/dev/WORKFLOW.md "Two-Tier Code Review" — keep all three in sync. TUI is
# intentionally absent: Tier 2 has no TUI lens, so TUI-only changes stay on Tier 1.
classify() {
  case "$1" in
    *.rs|Cargo.toml|*/Cargo.toml|Cargo.lock|*/Cargo.lock|rust-toolchain|rust-toolchain.toml|*/rust-toolchain|*/rust-toolchain.toml|.cargo/*|*/.cargo/*) echo rust ;;
    src/providers/*)               echo provider ;;
    src/core/tools/*)              echo tool ;;
    src/core/session/*|src/core/checkpoints/*) echo session ;;
    src/core/prompt/*|assets/prompts/*|assets/engines/*) echo prompt ;;
    src/core/gate/*)               echo gate ;;
    src/core/validators/*)         echo validators ;;
    src/core/engine/*)             echo engine ;;
    *)                             echo "" ;;
  esac
}

# distinct categories touched
categories=""
if [ "$file_count" -gt 0 ]; then
  categories=$(for f in "${changed_files[@]}"; do classify "$f"; done | grep . | sort -u)
fi
category_count=0
if [ -n "$categories" ]; then
  category_count=$(printf '%s\n' "$categories" | grep -c .)
fi
category_match=0
[ "$category_count" -gt 0 ] && category_match=1
cross_boundary=0
[ "$category_count" -ge 2 ] && cross_boundary=1

# ---- size floor: >= 8 files OR >= 300 net LOC (committed branch diff only) ---
loc=0
if [ -n "$mb" ]; then
  # numstat: "added\tdeleted\tpath"; "-" for binary. Sum added+deleted integers.
  loc=$(git diff --numstat "$mb" HEAD 2>/dev/null \
        | awk '{ a=($1=="-"?0:$1)+0; d=($2=="-"?0:$2)+0; s+=a+d } END { print s+0 }')
fi
size_floor=0
if [ "$file_count" -ge 8 ] || [ "$loc" -ge 300 ]; then
  size_floor=1
fi

# ---- release branch ----------------------------------------------------------
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
release=0
case "$branch" in
  release/*|main) release=1 ;;
esac
if [ "$base" = "main" ]; then release=1; fi
# base that looks like a version tag also counts
case "$base" in
  v*) release=1 ;;
esac

# ---- evaluate ---------------------------------------------------------------
reasons=()
if [ "$category_match" -eq 1 ]; then
  reasons+=("category_match: touches $(printf '%s' "$categories" | paste -sd, - | sed 's/,/, /g')")
else
  reasons+=("no_category_match: no high-risk domain file changed")
fi
if [ "$cross_boundary" -eq 1 ]; then reasons+=("cross_boundary: ${category_count} distinct domains"); fi
if [ "$size_floor" -eq 1 ]; then reasons+=("size_floor: ${file_count} files, ${loc} net LOC"); fi
if [ "$release" -eq 1 ]; then reasons+=("release_branch: branch=${branch} base=${base}"); fi
if [ "$committed_ok" -eq 0 ]; then reasons+=("base '${base}' not resolvable locally — committed-diff portion skipped"); fi

trigger=0
if [ "$category_match" -eq 1 ] && { [ "$cross_boundary" -eq 1 ] || [ "$size_floor" -eq 1 ] || [ "$release" -eq 1 ]; }; then
  trigger=1
fi
# No stable Rust directory map exists yet. Every Rust/build input enters all
# lenses, even a tiny diff in a newly named crate. Narrow only with an explicit
# reviewed domain map. An unresolved base cannot establish a safe exemption.
if printf '%s\n' "$categories" | grep -qx rust; then
  trigger=1
  reasons+=("rust_change: all Rust source/build paths require all five review lenses")
fi
if [ "$committed_ok" -eq 0 ]; then
  trigger=1
  reasons+=("unknown_scope: resolve the base before reviewing; no Tier 1 exemption")
fi

# ---- emit JSON --------------------------------------------------------------
# join reasons with ", " as quoted strings
joined=""
for r in "${reasons[@]}"; do
  # escape backslashes and double quotes for JSON safety
  esc=${r//\\/\\\\}
  esc=${esc//\"/\\\"}
  if [ -z "$joined" ]; then joined="\"${esc}\""; else joined="${joined}, \"${esc}\""; fi
done

base_esc=${base//\\/\\\\}
base_esc=${base_esc//\"/\\\"}
printf '{"trigger":%s,"base":"%s","reasons":[%s]}\n' \
  "$([ "$trigger" -eq 1 ] && echo true || echo false)" \
  "$base_esc" \
  "$joined"
exit 0
