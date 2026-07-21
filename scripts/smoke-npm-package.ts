import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json";

export {};

const packageDir = await mkdtemp(join(tmpdir(), "prism-vesicle-pack-"));
const installDir = await mkdtemp(join(tmpdir(), "prism-vesicle-install-"));
const configDir = await mkdtemp(join(tmpdir(), "prism-vesicle-config-"));

try {
  await run(["npm", "pack", "--pack-destination", packageDir], process.cwd());
  const tarball = (await readdir(packageDir)).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack did not create a tarball.");

  await run(["npm", "install", "--ignore-scripts", "--prefix", installDir, join(packageDir, tarball)], process.cwd());
  const executable = join(installDir, "node_modules", ".bin", "vesicle");
  await assertVersion(executable, installDir);
  await run([process.execPath, executable, "prompt", "shape", "--engine", "etl"], installDir, configDir);
  await run([process.execPath, executable, "debug", "markdown-runtime"], installDir, configDir);
  await run([process.execPath, executable, "assets", "materialize", "assets/prompts/engines/etl.md", "--global"], installDir, configDir);
  await run([process.execPath, executable, "assets", "status"], installDir, configDir);
  await run([process.execPath, executable, "assets", "init"], installDir, configDir);
  await run([process.execPath, executable, "prompt", "shape", "--engine", "etl"], installDir, configDir);
  console.log("npm package install smoke passed.");
} finally {
  await Promise.all([packageDir, installDir, configDir].map((dir) => rm(dir, { recursive: true, force: true })));
}

async function run(command: string[], cwd: string, configDir?: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env: {
      ...process.env,
      ...(configDir ? { XDG_CONFIG_HOME: configDir } : {}),
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed (exit ${exitCode}).`);
}

async function assertVersion(executable: string, cwd: string): Promise<void> {
  for (const flag of ["--version", "-v"]) {
    const child = Bun.spawn([process.execPath, executable, flag], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`${flag} failed (exit ${exitCode}); stderr=${stderr.slice(0, 200)}`);
    if (stdout.trim() !== packageJson.version) {
      throw new Error(`${flag} printed "${stdout.trim()}", expected ${packageJson.version}`);
    }
  }
}
