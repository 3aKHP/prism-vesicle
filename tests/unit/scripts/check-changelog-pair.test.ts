import { describe, expect, test } from "bun:test";
import { verifyChangelogPair } from "../../../scripts/check/check-changelog-pair";

describe("changelog pairing verification", () => {
  const paired = [
    "# 变更日志",
    "",
    "## [Unreleased]",
    "",
    "### 新增",
    "",
    "- 中文条目。",
    "- 另一条。",
    "",
    "## [1.0.0] - 2026-08-31",
    "",
    "### 修复",
    "",
    "- 修复条目。",
    "",
  ].join("\n");

  test("a structurally mirrored companion reports no problems", () => {
    const en = paired.replace("### 新增", "### Added").replace("### 修复", "### Fixed").replace("# 变更日志", "# Changelog").replace(/中文条目。|另一条。|修复条目。/g, "English bullet.");
    expect(verifyChangelogPair(en, paired)).toEqual([]);
  });

  test("a shifted or missing version heading is reported", () => {
    const drifted = paired.replace("## [1.0.0] - 2026-08-31", "## [0.9.0] - 2026-08-31");
    const problems = verifyChangelogPair(paired, drifted);
    expect(problems.some((p) => p.includes("version heading mismatch"))).toBe(true);
  });

  test("subsection and bullet count drift inside a version is reported", () => {
    const fewerBullets = paired.replace("- 另一条。\n", "");
    expect(verifyChangelogPair(paired, fewerBullets).some((p) => p.includes("bullet count mismatch"))).toBe(true);
    const fewerSubsections = paired.replace("### 修复\n\n", "");
    expect(verifyChangelogPair(paired, fewerSubsections).some((p) => p.includes("subsection count mismatch"))).toBe(true);
  });
});
