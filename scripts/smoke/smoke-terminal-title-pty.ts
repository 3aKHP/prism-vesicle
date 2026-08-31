/**
 * Real-PTY smoke for the host-owned terminal-title lifecycle.
 *
 * The child runs through `script` so the raw OSC title writes remain observable
 * while the TUI itself still receives a real interactive terminal.
 * This smoke is Linux/WSL-only; native Windows title acceptance is a separate
 * Windows Terminal/manual boundary and is not inferred from this script.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineProfileYaml, ETL_PROMPT, MOCK_ENV, providersYaml, SHARED_BASE_PROMPT } from "./support/pty-smoke";

const REPO_ROOT = join(import.meta.dir, "..", "..");

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasOscTitle(raw: string, title: string): boolean {
  return raw.includes(`\x1b]0;${title}\x07`) || raw.includes(`\x1b]2;${title}\x07`);
}

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    console.log("PTY terminal-title smoke skipped: script/stty harness requires Linux or WSL.");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "vesicle-terminal-title-pty-"));
  const project = join(root, "project");
  const configDir = join(root, "config");
  let server: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await mkdir(join(project, "assets", "prompts", "shared"), { recursive: true });
    await mkdir(join(project, "assets", "prompts", "engines"), { recursive: true });
    await mkdir(join(project, "assets", "engines"), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(join(project, "assets", "prompts", "shared", "vesicle-base.md"), SHARED_BASE_PROMPT, "utf8");
    await writeFile(join(project, "assets", "prompts", "engines", "etl.md"), ETL_PROMPT, "utf8");
    await writeFile(join(project, "assets", "engines", "etl.profile.yaml"), engineProfileYaml, "utf8");
    await writeFile(join(configDir, "settings.yaml"), "version: 1\nsessionTitle: off\n", "utf8");

    let calls = 0;
    server = Bun.serve({
      port: 0,
      fetch: async () => {
        calls += 1;
        await Bun.sleep(500);
        return Response.json({ id: `title-${calls}`, choices: [{ message: { content: `reply ${calls}` } }] });
      },
    });
    await writeFile(join(configDir, "providers.yaml"), providersYaml(server.port ?? 0), "utf8");
    await writeFile(join(configDir, ".env"), MOCK_ENV, "utf8");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VESICLE_CONFIG_DIR: configDir,
      VESICLE_TERMINAL_TITLE: "on",
      VESICLE_REDUCED_MOTION: "1",
      TERM: "xterm-256color",
    };
    const logPath = join(root, "pty.log");
    const command = `stty cols 100 rows 28; bun ${shellQuote(join(REPO_ROOT, "src", "cli", "main.ts"))} ${shellQuote(project)}`;
    const spawned = Bun.spawn(["script", "-qfe", "-c", command, logPath], {
      cwd: REPO_ROOT,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child = spawned;
    const stdin = spawned.stdin!;
    let raw = "";
    const reader = spawned.stdout!.getReader();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += new TextDecoder().decode(value);
      }
    })();
    const type = (value: string) => { stdin.write(value); stdin.flush(); };
    const waitFor = async (predicate: () => boolean, timeoutMs = 15000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await Bun.sleep(100);
      }
      return false;
    };

    await Bun.sleep(1200);
    type("x");
    await Bun.sleep(250);
    const idle = await waitFor(() => hasOscTitle(raw, "· Prism Vesicle · project"));
    type("ping");
    await Bun.sleep(60);
    type("\r");
    const working = await waitFor(() => hasOscTitle(raw, "◰ Prism Vesicle · project"), 20000);
    const replied = await waitFor(() => raw.includes("reply 1"), 20000);
    type("\x03");
    await Bun.sleep(250);
    type("\x03");
    await Promise.race([spawned.exited, Bun.sleep(3000)]);
    await Promise.race([pump, Bun.sleep(1000)]);
    const cleared = hasOscTitle(raw, "");

    console.log(`\n## PTY terminal-title smoke (provider calls: ${calls})`);
    console.log(`idle title: ${idle}`);
    console.log(`working title: ${working}`);
    console.log(`provider reply: ${replied}`);
    console.log(`clear title: ${cleared}`);
    if (!idle) throw new Error("idle terminal title was not observed");
    if (!working) throw new Error("reduced-motion working terminal title was not observed");
    if (!replied) throw new Error("provider reply was not observed");
    if (!cleared) throw new Error("terminal title cleanup was not observed");
    console.log("PTY terminal-title smoke passed.");
  } finally {
    try { child?.kill(); } catch { /* already exited */ }
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
