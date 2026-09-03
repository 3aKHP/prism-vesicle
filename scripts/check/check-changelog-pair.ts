/**
 * Validate the structural pairing between CHANGELOG.md and CHANGELOG.zh-CN.md.
 *
 * Usage:
 *   bun run scripts/check/check-changelog-pair.ts
 *
 * `CHANGELOG.md` is the canonical English changelog; `CHANGELOG.zh-CN.md` is
 * its Simplified Chinese companion that release-note composition interleaves
 * per version section (scripts/release/compose-notes.ts). The companion must
 * mirror the English structure exactly: the identical `## [version]` heading
 * sequence, and identical per-version `###` subsection and bullet counts.
 * Translation quality is a review concern, not a structural one. Enforced in
 * CI through tests/contract/release/release-notes.test.ts and in the local
 * pre-commit hook (.githooks/pre-commit); exits non-zero listing every drift.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CHANGELOG_EN = resolve(PROJECT_ROOT, "CHANGELOG.md");
const CHANGELOG_ZH = resolve(PROJECT_ROOT, "CHANGELOG.zh-CN.md");

export type ChangelogSection = { anchor: string; subsections: string[]; bullets: number };

/** Structural skeleton of a changelog: version headings, their `###` subsections, and bullet counts. */
export function parseChangelogSkeleton(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## [")) {
      current = { anchor: line, subsections: [], bullets: 0 };
      sections.push(current);
    } else if (current && line.startsWith("### ")) {
      current.subsections.push(line);
    } else if (current && line.startsWith("- ")) {
      current.bullets += 1;
    }
  }
  return sections;
}

/** Pairing problems between the English changelog and its Chinese companion; empty means in pair. */
export function verifyChangelogPair(en: string, zh: string): string[] {
  const problems: string[] = [];
  const enSections = parseChangelogSkeleton(en);
  const zhSections = parseChangelogSkeleton(zh);
  const count = Math.max(enSections.length, zhSections.length);
  for (let i = 0; i < count; i++) {
    const a = enSections[i];
    const b = zhSections[i];
    if (!a || !b) {
      problems.push(`version heading count mismatch: English has ${enSections.length}, Chinese companion has ${zhSections.length}`);
      break;
    }
    if (a.anchor !== b.anchor) {
      problems.push(`version heading mismatch at position ${i + 1}: English ${JSON.stringify(a.anchor)} vs companion ${JSON.stringify(b.anchor)}`);
      continue;
    }
    if (a.subsections.length !== b.subsections.length) {
      problems.push(`subsection count mismatch for ${a.anchor}: English ${a.subsections.length} vs companion ${b.subsections.length}`);
    }
    if (a.bullets !== b.bullets) {
      problems.push(`bullet count mismatch for ${a.anchor}: English ${a.bullets} vs companion ${b.bullets}`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = verifyChangelogPair(readFileSync(CHANGELOG_EN, "utf8"), readFileSync(CHANGELOG_ZH, "utf8"));
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`changelog pair drift: ${problem}`);
    }
    console.error("CHANGELOG.zh-CN.md must mirror CHANGELOG.md: identical ## version headings and matching per-version ### subsection and bullet counts.");
    process.exit(1);
  }
  console.log("CHANGELOG.md and CHANGELOG.zh-CN.md are in pair (anchors, subsections, bullets).");
}
