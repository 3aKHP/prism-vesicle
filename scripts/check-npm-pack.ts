type PackFile = { path: string };
type PackResult = { files?: PackFile[] };

export {};

const child = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {
  cwd: process.cwd(),
  stdout: "pipe",
  stderr: "inherit",
});
const stdout = await new Response(child.stdout).text();
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`npm pack --dry-run failed (exit ${exitCode}).`);

const [result] = JSON.parse(stdout) as PackResult[];
const paths = result.files?.map((file) => file.path) ?? [];
if (paths.length === 0) throw new Error("npm pack --dry-run did not report any package files.");

const forbidden = paths.filter((path) => /^(?:\.github\/|docs\/|tests\/|dev\/|scripts\/|AGENTS\.md$|CLAUDE\.md$)/.test(path));
if (forbidden.length > 0) {
  throw new Error(`npm package contains development-only files: ${forbidden.join(", ")}`);
}

const tempArtifacts = paths.filter((path) => /\.references-(?:staging|old)-\d+/.test(path));
if (tempArtifacts.length > 0) {
  throw new Error(`npm package contains sync-script temporary artifacts: ${tempArtifacts.join(", ")}`);
}

for (const required of [
  "bin/vesicle.mjs",
  "dist/npm/vesicle.mjs",
  "harness-manifest.json",
  "assets/engines/etl.profile.yaml",
  "host-assets/prompts/shared/vesicle-base.md",
  "host-assets/prompts/shared/side-question.md",
  "host-assets/skills/vesicle-docs/SKILL.md",
  "host-assets/skills/vesicle-docs/references/index.md",
  "host-assets/skills/vesicle-docs/references/root-readme.md",
  "host-assets/skills/vesicle-docs/references/dev-skills.md",
  "host-assets/skills/vesicle-docs/references/user-zh-cn-reference-configuration.md",
  "host-assets/skills/vesicle-docs/references/user-en-reference-configuration.md",
  "host-assets/skills/skillify/SKILL.md",
  "host-assets/skills/skillify/scripts/publish_skill.sh",
  "host-assets/skills/skillify/scripts/publish_skill.ps1",
]) {
  if (!paths.includes(required)) throw new Error(`npm package is missing required runtime file: ${required}`);
}

const rawApplicationSources = paths.filter((path) => path.startsWith("src/") || /\.(?:jsx|tsx)$/.test(path));
if (rawApplicationSources.length > 0) {
  throw new Error(`npm package contains raw application sources: ${rawApplicationSources.join(", ")}`);
}
if (paths.includes("dist/npm/vesicle.meta.json")) {
  throw new Error("npm package contains its development-only build metafile.");
}

console.log(`npm package shape verified: ${paths.length} files.`);
