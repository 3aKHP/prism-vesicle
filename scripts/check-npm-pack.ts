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

for (const required of ["src/cli/main.ts", "assets/manifest.json"]) {
  if (!paths.includes(required)) throw new Error(`npm package is missing required runtime file: ${required}`);
}

console.log(`npm package shape verified: ${paths.length} files.`);
