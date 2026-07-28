#!/bin/sh
# word-count.sh — print TSV of path, word count, line count for each argument.
# Requires only POSIX sh and wc. Used by the research-synthesis Skill to
# measure source volume before synthesis.
set -e
printf 'path\twords\tlines\n'
for file in "$@"; do
  if [ ! -f "$file" ]; then
    printf '%s\tMISSING\tMISSING\n' "$file" >&2
    continue
  fi
  words=$(wc -w < "$file")
  lines=$(wc -l < "$file")
  printf '%s\t%s\t%s\n' "$file" "$words" "$lines"
done
