import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256 } from "../../check/migration/check";

export async function treeManifest(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(relative: string) {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`unexpected oracle symlink: ${path}`);
      if (entry.isDirectory()) { files[`${path}/`] = "directory"; await walk(path); }
      else if (entry.isFile()) files[path] = sha256(await readFile(join(root, path)));
      else throw new Error(`unexpected oracle special file: ${path}`);
    }
  }
  await walk("");
  return files;
}

export async function isolatedConfig(root: string, endpoint: string): Promise<NodeJS.ProcessEnv> {
  const config = join(root, "config");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "providers.yaml"), `# preserve this comment\ndefault:\n  provider: oracle\n  model: oracle-model\nproviders:\n  oracle:\n    protocol: openai-chat-compatible\n    baseUrl: ${endpoint}/v1\n    apiKeyEnv: ORACLE_FIXTURE_KEY\n    models:\n      - oracle-model\n      - oracle-alt\n`);
  await writeFile(join(config, ".env"), "ORACLE_FIXTURE_KEY=synthetic-fixture-key\n");
  await writeFile(join(config, "settings.yaml"), "version: 1\nsessionTitle: off\n");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SYSTEMROOT", "SystemRoot", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "TERM"]) if (process.env[key]) env[key] = process.env[key];
  return { ...env, VESICLE_CONFIG_DIR: config, VESICLE_PROVIDERS_FILE: join(config, "providers.yaml"), VESICLE_MCP_FILE: join(config, "absent-mcp.yaml"), VESICLE_PERMISSIONS_FILE: join(config, "absent-permissions.yaml"), VESICLE_QUALITY_FILE: join(config, "absent-quality.yaml"), VESICLE_SETTINGS_FILE: join(config, "settings.yaml") };
}

export async function execute(args: string[], cwd: string, env: NodeJS.ProcessEnv, logPath: string, expectedExit = 0, timeoutMs = 30_000) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    await writeFile(logPath, JSON.stringify({ command: [process.execPath, ...args], exitCode: exit, timedOut, stdout, stderr }, null, 2));
    assert.equal(timedOut, false, `oracle child exceeded ${timeoutMs} ms`);
    assert.equal(exit, expectedExit, `oracle command failed: ${stderr}`);
    return { stdout, stderr, exit };
  } finally { clearTimeout(timer); }
}

export const workerPath = resolve(import.meta.dir, "worker.ts");
