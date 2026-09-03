import { describe, expect, test } from "bun:test";
import {
  channelForVersion,
  compareSemver,
  composeReleaseBody,
  derivePreviousTag,
  extractChangelogSection,
  isStableTag,
  parseSemverTag,
} from "../../../scripts/release/compose-notes";

describe("semver tag handling", () => {
  test("orders the real release line with numeric prerelease identifiers", () => {
    const line = ["v0.1.0", "v1.0.0-alpha.9", "v1.0.0-alpha.10", "v1.0.0-beta.2", "v1.0.0-rc.1", "v1.0.0", "v1.1.0"];
    const sorted = [...line].sort((a, b) => compareSemver(parseSemverTag(a)!, parseSemverTag(b)!));
    expect(sorted).toEqual(line);
  });

  test("rejects non-semver tags such as checkpoint markers", () => {
    expect(parseSemverTag("checkpoint/dogfood-exe-tui-working")).toBeNull();
    expect(isStableTag("v1.0.0-rc.1")).toBe(false);
    expect(isStableTag("v1.0.0")).toBe(true);
  });

  test("derives the channel from the version the way the release workflow does", () => {
    expect(channelForVersion("1.1.0")).toBe("stable");
    expect(channelForVersion("1.1.0-rc.1")).toBe("rc");
    expect(channelForVersion("1.1.0-beta.3")).toBe("beta");
  });
});

describe("deterministic compare-base derivation", () => {
  test("v1.0.0 sentinel: picks the preceding prerelease, never the v0.1.0 fallback (issue #268 item 10)", () => {
    // GitHub's autogen skipped prerelease baselines for the first
    // non-prerelease and fell back to the earliest tag; the drafted
    // "previous stable, else newest prerelease" rule answers v0.1.0 here too,
    // because v0.1.0 is a stable tag. Only the any-channel rule is correct.
    const tags = ["checkpoint/foo", "v0.1.0", "v1.0.0-rc.1", "v1.0.0"];
    expect(derivePreviousTag(tags, "1.0.0")).toBe("v1.0.0-rc.1");
  });

  test("stable after stable compares against the previous release", () => {
    expect(derivePreviousTag(["v1.0.0"], "1.1.0")).toBe("v1.0.0");
    expect(derivePreviousTag(["v1.1.0", "v1.0.0"], "1.1.0")).toBe("v1.0.0");
  });

  test("a prerelease compares against the newest preceding release of any channel", () => {
    expect(derivePreviousTag(["v1.0.0-rc.1", "v1.0.0", "v0.1.0"], "1.1.0-rc.1")).toBe("v1.0.0");
  });
});

describe("CHANGELOG section extraction", () => {
  const markdown = [
    "# Changelog",
    "",
    "## [1.0.0] - 2026-08-31",
    "",
    "### Added",
    "",
    "- First bullet.",
    "",
    "### Fixed",
    "",
    "- Second bullet.",
    "",
    "## [0.1.0] - 2026-07-07",
    "",
    "### Added",
    "",
    "- Older bullet.",
    "",
  ].join("\n");

  test("slices one version section without its heading, trimmed", () => {
    expect(extractChangelogSection(markdown, "1.0.0")).toBe(
      ["### Added", "", "- First bullet.", "", "### Fixed", "", "- Second bullet."].join("\n"),
    );
  });

  test("excludes the trailing link-reference footer when extracting the oldest section", () => {
    const withFooter = `${markdown}\n[Unreleased]: https://github.com/example/prism-vesicle/compare/v1.0.0...HEAD\n`;
    expect(extractChangelogSection(withFooter, "0.1.0")).toBe(["### Added", "", "- Older bullet."].join("\n"));
  });

  test("fails closed when the version heading is absent", () => {
    expect(() => extractChangelogSection(markdown, "2.0.0")).toThrow("CHANGELOG section not found: [2.0.0]");
  });
});

describe("release body assembly", () => {
  const base = {
    enSection: "### Added\n\n- English bullet.",
    zhSection: "### 新增\n\n- 中文条目。",
    repoUrl: "https://github.com/example/prism-vesicle",
  };

  test("stable after stable: no channel block, bilingual sections, slimmed disclosures, compare link", () => {
    const body = composeReleaseBody({
      ...base,
      version: "1.1.0",
      channel: "stable",
      prevTag: "v1.0.0",
      previousStableExists: true,
    });
    expect(body).toContain("## What's Changed / 变更内容");
    expect(body).toContain("- English bullet.");
    expect(body).toContain("- 中文条目。");
    expect(body).not.toContain("## Stable channel and known limits");
    expect(body).toContain("**Full Changelog**: https://github.com/example/prism-vesicle/compare/v1.0.0...v1.1.0");
    // Slimmed standing disclosures: the signing status is two bilingual lines
    // with policy links, and the provider-native search paragraph is gone for
    // good (it documents configuration and lives in the user manual).
    expect(body).toContain("not Authenticode-signed");
    expect(body).toContain("未经 Authenticode 签名");
    expect(body).toContain("/blob/main/CODE_SIGNING_POLICY.zh-CN.md)");
    expect(body).not.toContain("Provider-native search");
    expect(body).not.toContain("websearch");
  });

  test("prereleases and first-of-channel stables carry the dist-tag guidance with the version substituted", () => {
    const rc = composeReleaseBody({
      ...base,
      version: "1.1.0-rc.1",
      channel: "rc",
      prevTag: "v1.0.0",
      previousStableExists: true,
    });
    expect(rc).toContain("## Release candidate channel and known limits / RC 频道与已知限制");
    expect(rc).toContain("`1.1.0-rc.1` is a release candidate");
    // RC wording steers consumers to next while latest keeps tracking the beta line.
    expect(rc).toContain("npm install -g prism-vesicle@next");
    expect(rc).not.toContain("%VERSION%");
    expect(rc).toContain("compare/v1.0.0...v1.1.0-rc.1");

    const firstStable = composeReleaseBody({
      ...base,
      version: "2.0.0",
      channel: "stable",
      prevTag: "v1.1.0-rc.2",
      previousStableExists: false,
    });
    expect(firstStable).toContain("## Stable channel and known limits / 稳定频道与已知限制");
  });
});
