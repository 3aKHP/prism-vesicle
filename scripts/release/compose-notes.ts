/**
 * Compose the GitHub Release body from the paired bilingual CHANGELOG.
 *
 * Invoked by `.github/workflows/release.yml` at tag publication. GitHub's
 * `generate_release_notes` autogen chooses its own compare base and, for a
 * repository's first non-prerelease, skips every prerelease baseline and falls
 * back to the earliest tag — the published v1.0.0 body carried the whole
 * v0.1.0...v1.0.0 PR history because of that rule (issue #268 item 10). This
 * script replaces the autogen entirely: the body is the released version's
 * section from `CHANGELOG.md` interleaved with its Simplified Chinese
 * companion `CHANGELOG.zh-CN.md`, standing disclosures are slimmed to the
 * two-line signing status and the one-line MCP deferral pointer (the
 * provider-native search disclosure documents configuration and lives in the
 * user manual), and the trailing Full Changelog link uses a deterministically
 * derived compare base.
 *
 * The compare base is the immediately preceding published tag of ANY channel,
 * not "previous stable, else newest prerelease": every prerelease here ships
 * its own CHANGELOG section, so the version section's span and the compare
 * span must agree. The earlier draft rule answers `v0.1.0` for `v1.0.0` and
 * reproduces the autogen incident; the sentinel test in
 * `tests/unit/scripts/compose-notes.test.ts` pins the corrected rule.
 *
 * Usage (workflow): `bun scripts/release/compose-notes.ts --version <version>
 * [--out <path>]`. Without `--out` the body prints to stdout. The semver,
 * derivation, extraction, and assembly helpers are pure; only the thin main
 * below touches git and the filesystem.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const PROJECT_ROOT = resolve(import.meta.dir, "..", "..");
const CHANGELOG_EN = resolve(PROJECT_ROOT, "CHANGELOG.md");
const CHANGELOG_ZH = resolve(PROJECT_ROOT, "CHANGELOG.zh-CN.md");
const DEFAULT_REPO_URL = "https://github.com/3aKHP/prism-vesicle";

export type ReleaseChannel = "stable" | "rc" | "beta";

export type Semver = { core: [number, number, number]; pre: (number | string)[] };

/** Parse a `v`-prefixed semver tag; returns null for anything else (checkpoint/* and friends). */
export function parseSemverTag(tag: string): Semver | null {
  const m = tag.match(/^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** Full semver precedence: core fields numerically, then prerelease identifiers (numeric < alphanumeric, shorter prefix is lower, release > prerelease). */
export function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const isStableTag = (tag: string): boolean => {
  const parsed = parseSemverTag(tag);
  return parsed !== null && parsed.pre.length === 0;
};

/** Mirrors the channel derivation of the release workflow's metadata job. */
export function channelForVersion(version: string): ReleaseChannel {
  if (version.includes("-rc.")) return "rc";
  if (version.includes("-")) return "beta";
  return "stable";
}

/**
 * Deterministic compare base: the newest `v`-semver tag strictly below
 * `v<version>`, regardless of channel (see the header for why). Returns
 * undefined when no prior published tag exists.
 */
export function derivePreviousTag(tags: string[], version: string): string | undefined {
  const current = `v${version}`;
  const cur = parseSemverTag(current);
  if (!cur) throw new Error(`not a semver version: ${version}`);
  return tags
    .map((tag) => ({ tag, parsed: parseSemverTag(tag) }))
    .filter((t): t is { tag: string; parsed: Semver } => t.parsed !== null)
    .filter((t) => t.tag !== current && compareSemver(t.parsed, cur) < 0)
    .sort((a, b) => compareSemver(b.parsed, a.parsed))[0]?.tag;
}

/** Slice one `## [<anchor>]` version section (heading excluded, trimmed); fails closed when absent. */
export function extractChangelogSection(markdown: string, anchor: string): string {
  // Headings carry a date suffix at release time (`## [1.1.0] - 2026-09-14`),
  // so match the bracketed anchor as a prefix; the closing `]` keeps
  // `1.0.0` from matching `1.0.0-alpha.1`. The oldest section ends at the
  // trailing link-reference footer (`[Unreleased]: …/compare/…` lines).
  const prefix = `## [${anchor}]`;
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(prefix));
  if (start === -1) {
    throw new Error(`CHANGELOG section not found: [${anchor}] — the release PR must stamp the version heading before tagging`);
  }
  const end = lines.findIndex((line, i) => i > start && (line.startsWith("## ") || line.startsWith("[")));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

const CHANNEL_BLOCKS: Record<ReleaseChannel, string> = {
  rc: `## Release candidate channel and known limits / RC 频道与已知限制

\`%VERSION%\` is a release candidate published to npm's \`next\` dist-tag. The \`latest\` dist-tag intentionally keeps tracking the newest beta, so \`npm install -g prism-vesicle\` continues to install the beta line; install the candidate explicitly with \`npm install -g prism-vesicle@next\` or by pinning \`%VERSION%\`. Release candidates are stabilization builds for early testing and may still change before the stable release.

\`%VERSION%\` 是发布候选 (RC),发布到 npm 的 \`next\` dist-tag。\`latest\` dist-tag 会有意继续跟随最新 Beta,因此 \`npm install -g prism-vesicle\` 仍会安装 Beta 线;请使用 \`npm install -g prism-vesicle@next\` 或固定 \`%VERSION%\` 来显式安装候选版本。发布候选是面向早期测试的稳定化构建,在稳定版发布前仍可能调整。`,
  beta: `## Beta channel and known limits / Beta 频道与已知限制

npm's \`latest\` dist-tag intentionally tracks the newest beta during the beta line, so \`npm install -g prism-vesicle\` installs \`%VERSION%\` once publication completes. Pin an explicit older version to remain on an alpha build.

Beta 阶段中,npm 的 \`latest\` dist-tag 会有意跟随最新 Beta,因此发布完成后 \`npm install -g prism-vesicle\` 会安装 \`%VERSION%\`。如需继续停留在 Alpha 构建,请显式固定旧版本。`,
  stable: `## Stable channel and known limits / 稳定频道与已知限制

npm's \`latest\` dist-tag tracks the newest stable release, so \`npm install -g prism-vesicle\` installs \`%VERSION%\` once publication completes. Earlier prerelease builds remain available through the \`next\` dist-tag and explicit versions.

npm 的 \`latest\` dist-tag 跟随最新稳定版,发布完成后 \`npm install -g prism-vesicle\` 会安装 \`%VERSION%\`。更早的预发布构建仍可通过 \`next\` dist-tag 与显式版本号获取。`,
};

/** Assemble the bilingual release body from the paired sections and the derived compare base. */
export function composeReleaseBody(input: {
  version: string;
  channel: ReleaseChannel;
  enSection: string;
  zhSection: string;
  prevTag: string;
  previousStableExists: boolean;
  repoUrl: string;
}): string {
  const { version, channel, enSection, zhSection, prevTag, previousStableExists, repoUrl } = input;
  const parts: string[] = [];
  // Dist-tag guidance only where it carries information: prereleases, and a
  // stable release with no prior stable (the first-of-channel case).
  if (channel !== "stable" || !previousStableExists) {
    parts.push(CHANNEL_BLOCKS[channel].replaceAll("%VERSION%", version));
  }
  parts.push(`## What's Changed / 变更内容\n\n${enSection}\n\n---\n\n${zhSection}`);
  parts.push(
    `## Windows code-signing status / Windows 代码签名状态\n\nThe Windows executable and installer are not Authenticode-signed. Download only from this official GitHub Release and verify each file against \`SHA256SUMS.txt\`. See the [Code Signing Policy](${repoUrl}/blob/main/CODE_SIGNING_POLICY.md).\n\nWindows 可执行文件与安装器未经 Authenticode 签名。请只从本 GitHub Release 官方页面下载,并使用 \`SHA256SUMS.txt\` 逐项核对;参见[代码签名政策](${repoUrl}/blob/main/CODE_SIGNING_POLICY.zh-CN.md)。`,
  );
  parts.push(
    `Non-image MCP rich results (resource, audio, URL/link) remain deferred: omitted without auto-fetch or prompt injection. See \`STATUS.md\` and Issue #177 for the current boundary.\n\n非图像的 MCP 富结果(resource、audio、URL/link)仍处于延后状态:忽略且不自动抓取、不注入提示。当前边界见 \`STATUS.md\` 与 Issue #177。`,
  );
  parts.push(`**Full Changelog**: ${repoUrl}/compare/${prevTag}...v${version}`);
  return `${parts.join("\n\n")}\n`;
}

function listTags(): string[] {
  return execFileSync("git", ["tag", "--list"], { cwd: PROJECT_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const version = (() => {
    const i = args.indexOf("--version");
    if (i === -1 || !args[i + 1]) {
      throw new Error("usage: bun scripts/release/compose-notes.ts --version <version> [--out <path>]");
    }
    return args[i + 1];
  })();
  const outIndex = args.indexOf("--out");
  const out = outIndex !== -1 ? args[outIndex + 1] : undefined;
  const repoIndex = args.indexOf("--repo-url");
  const repoUrl = repoIndex !== -1 && args[repoIndex + 1] ? args[repoIndex + 1] : DEFAULT_REPO_URL;

  const tags = listTags();
  const prevTag = derivePreviousTag(tags, version);
  if (!prevTag) {
    throw new Error(`no published tag precedes v${version} — refusing to compose a baseline-less release body`);
  }
  const currentTag = `v${version}`;
  const current = parseSemverTag(currentTag);
  if (!current) throw new Error(`not a semver version: ${version}`);
  const previousStableExists = tags.some((tag) => {
    if (tag === currentTag) return false;
    const parsed = parseSemverTag(tag);
    return parsed !== null && parsed.pre.length === 0 && compareSemver(parsed, current) < 0;
  });
  const body = composeReleaseBody({
    version,
    channel: channelForVersion(version),
    enSection: extractChangelogSection(readFileSync(CHANGELOG_EN, "utf8"), version),
    zhSection: extractChangelogSection(readFileSync(CHANGELOG_ZH, "utf8"), version),
    prevTag,
    previousStableExists,
    repoUrl,
  });
  if (out) {
    writeFileSync(resolve(process.cwd(), out), body);
    console.log(`composed release notes for v${version} (${prevTag}...v${version}) -> ${out}`);
  } else {
    console.log(body);
  }
}
