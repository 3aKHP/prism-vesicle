#!/usr/bin/env bash
# deep-cr-trigger.sh — deterministic, read-only gate for the Tier 2 deep-cr review.
#
# Prints a single JSON object {"trigger":bool,"reasons":[...]} and exits 0.
# Never modifies state. The rule mirrors docs/dev/WORKFLOW.md "Rapid Development
# Exception" high-risk list:
#
#   trigger = CATEGORY_MATCH && (CROSS_BOUNDARY || SIZE_FLOOR || RELEASE_BRANCH)
#
# Usage: scripts/check/deep-cr-trigger.sh [base]    (base defaults to "develop")
set -u

base="${1:-develop}"

# ---- collect the changed file set (committed + staged + unstaged) ------------
mb=""
committed_ok=1
mb_out=$(git merge-base HEAD "$base" 2>/dev/null) || committed_ok=0
if [ "$committed_ok" -eq 1 ] && [ -n "$mb_out" ]; then
  mb="$mb_out"
fi

# Collect changed files (committed + staged + unstaged) via command substitution.
# NOTE: do NOT pipe git output into a function that mutates a variable — bash runs
# pipeline commands in a subshell, so the mutation would be lost and the set empty.
changed_raw=""
if [ -n "$mb" ]; then changed_raw="${changed_raw}$(git diff --name-only "$mb" HEAD 2>/dev/null)"$'\n'; fi
changed_raw="${changed_raw}$(git diff --name-only 2>/dev/null)"$'\n'          # unstaged
changed_raw="${changed_raw}$(git diff --name-only --cached 2>/dev/null)"$'\n'  # staged

# distinct file list + count
distinct_files=$(printf '%s' "$changed_raw" | grep . | sort -u)
file_count=0
if [ -n "$distinct_files" ]; then
  file_count=$(printf '%s\n' "$distinct_files" | grep -c .)
fi

# ---- map a path to its high-risk domain category (or empty) ------------------
classify() {
  case "$1" in
    src/providers/*)               echo provider ;;
    src/core/tools/*)              echo tool ;;
    src/core/session/*|src/core/checkpoints/*) echo session ;;
    src/core/prompt/*|assets/prompts/*|assets/engines/*) echo prompt ;;
    src/tui/*)                     echo tui ;;
    src/core/gate/*)               echo gate ;;
    src/core/validators/*)         echo validators ;;
    src/core/engine/*)             echo engine ;;
    *)                             echo "" ;;
  esac
}

# distinct categories touched
categories=""
if [ -n "$distinct_files" ]; then
  categories=$(printf '%s\n' "$distinct_files" | while IFS= read -r f; do classify "$f"; done | grep . | sort -u)
fi
category_count=0
if [ -n "$categories" ]; then
  category_count=$(printf '%s\n' "$categories" | grep -c .)
fi
category_match=0
[ "$category_count" -gt 0 ] && category_match=1
cross_boundary=0
[ "$category_count" -ge 2 ] && cross_boundary=1

# ---- size floor: >= 8 files OR >= 300 net LOC --------------------------------
loc=0
# numstat: "added\tdeleted\tpath"; "-" for binary. Sum added+deleted integers
# across committed (if base resolvable), unstaged, and staged.
loc_raw=""
if [ -n "$mb" ]; then loc_raw="${loc_raw}$(git diff --numstat "$mb" HEAD 2>/dev/null)"$'\n'; fi
loc_raw="${loc_raw}$(git diff --numstat 2>/dev/null)"$'\n'
loc_raw="${loc_raw}$(git diff --numstat --cached 2>/dev/null)"$'\n'
loc=$(printf '%s' "$loc_raw" | awk '{ a=($1=="-"?0:$1)+0; d=($2=="-"?0:$2)+0; s+=a+d } END { print s+0 }')
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
  reasons+=("category_match: touches $(printf '%s' "$categories" | paste -sd', ' -)")
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

# ---- emit JSON --------------------------------------------------------------
# join reasons with ", " as quoted strings
joined=""
for r in "${reasons[@]}"; do
  # escape backslashes and double quotes for JSON safety
  esc=${r//\\/\\\\}
  esc=${esc//\"/\\\"}
  if [ -z "$joined" ]; then joined="\"${esc}\""; else joined="${joined}, \"${esc}\""; fi
done

printf '{"trigger":%s,"base":"%s","reasons":[%s]}\n' \
  "$([ "$trigger" -eq 1 ] && echo true || echo false)" \
  "$base" \
  "$joined"
exit 0
