/**
 * Real-PTY smoke for Workspace text-paste routing (PR #139 follow-up).
 *
 * Drives the real TUI (bun src/cli/main.ts) inside a `script`-allocated
 * pseudo-terminal against a local mock provider, through:
 *
 *   /workspace notes.txt  →  editable source  →  bracketed paste  →  Ctrl+S
 *
 * The primary oracle is the file content on disk, not the rendered PTY
 * stream: `script` captures a cumulative byte stream, so the pasted marker
 * could appear in the output even if it only landed in the hidden shared
 * composer. Reading `notes.txt` after the save proves the paste reached the
 * focused OpenTUI textarea, mutated the editor buffer, and persisted.
 *
 * Before the routing fix this smoke fails because the global paste handler
 * consumes the event into the shared composer and the file stays unchanged.
 * After the fix, the global handler leaves the event unconsumed for the
 * editable editor, OpenTUI's real TextareaRenderable.handlePaste inserts it,
 * and Ctrl+S persists it.
 *
 * Usage: bun run scripts/smoke/smoke-workspace-paste-pty.ts [width] [height]
 * Exits non-zero if any regression signature is detected.
 */
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ETL_PROMPT,
  MOCK_ENV,
  SHARED_BASE_PROMPT,
  engineProfileYaml,
  providersYaml,
  stripAnsi,
} from "./support/pty-smoke";

export {};

const WIDTH = Number(process.argv[2] ?? 80);
const HEIGHT = Number(process.argv[3] ?? 24);
const REPO_ROOT = join(import.meta.dir, "..", "..");
const NOTES_REL = "notes.txt";
const PREFIX = "prefix line\n";
const PASTE_MARKER = "PASTE-LINE-1\nPASTE-LINE-2";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-ws-paste-pty-"));
  const project = join(root, "project");
  const configDir = join(root, "config");
  await mkdir(project, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(join(project, "workspace"), { recursive: true });
  await writeFile(join(project, NOTES_REL), PREFIX, "utf8");

  let providerCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      providerCalls += 1;
      return Response.json({ id: "mock", choices: [{ message: { content: "ok" } }] });
    },
  });

  await writeFile(join(configDir, "providers.yaml"), providersYaml(server.port ?? 0), "utf8");
  await writeFile(join(configDir, ".env"), MOCK_ENV, "utf8");

  const sharedDir = join(project, "assets", "prompts", "shared");
  const engineDir = join(project, "assets", "prompts", "engines");
  const enginesDir = join(project, "assets", "engines");
  await mkdir(sharedDir, { recursive: true });
  await mkdir(engineDir, { recursive: true });
  await mkdir(enginesDir, { recursive: true });
  await writeFile(join(sharedDir, "vesicle-base.md"), SHARED_BASE_PROMPT, "utf8");
  await writeFile(join(engineDir, "etl.md"), ETL_PROMPT, "utf8");
  await writeFile(join(enginesDir, "etl.profile.yaml"), engineProfileYaml, "utf8");

  const env: NodeJS.ProcessEnv = { ...process.env };
  env.VESICLE_PROVIDERS_FILE = join(configDir, "providers.yaml");
  env.VESICLE_REDUCED_MOTION = "1";
  env.TERM = "xterm-256color";

  const child = Bun.spawn(
    ["script", "-qfe", "-c", `stty cols ${WIDTH} rows ${HEIGHT}; bun ${join(REPO_ROOT, "src", "cli", "main.ts")} ${project}`, join(root, "pty.log")],
    { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe", stdin: "pipe" },
  );
  const stdin = child.stdin!;
  let accumulated = "";
  const reader = child.stdout!.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
    }
    accumulated += decoder.decode();
  })();

  const type = (text: string) => {
    try { stdin.write(text); stdin.flush(); } catch { /* child exited */ }
  };
  const plain = () => stripAnsi(accumulated);
  const waitFor = async (marker: string | RegExp, timeoutMs = 15000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (new RegExp(marker).test(plain())) return true;
      await Bun.sleep(150);
    }
    return false;
  };
  const fail = (msg: string) => { console.log(`FAIL: ${msg}`); process.exitCode = 1; };

  let disk = "";
  try {
    await Bun.sleep(2800); // let the renderer + composer fully activate (splash auto-dismisses)
    // Open the editable file through the same tab-completion-safe command
    // entry the Workspace status smoke uses.
    type("/");
    await Bun.sleep(150);
    for (const ch of "workspace") { type(ch); await Bun.sleep(40); }
    await Bun.sleep(200);
    type("\t"); // complete `/workspace` → `/workspace ` (menu closes)
    await Bun.sleep(200);
    for (const ch of NOTES_REL) { type(ch); await Bun.sleep(40); }
    await Bun.sleep(200);
    type("\r");

    // Use the status row as a synchronization hint. The cumulative PTY diff
    // stream can omit a complete literal status string, so the exact disk
    // content below remains the authoritative editable-source oracle.
    await waitFor("Ctrl\\+S save", 20000);
    await Bun.sleep(500); // let the textarea focus settle

    // One bracketed-paste sequence straight to PTY stdin.
    type("\x1b[200~" + PASTE_MARKER + "\x1b[201~");
    await Bun.sleep(800);

    // Save (Ctrl+S). The confirmation is another synchronization hint; disk
    // content, rather than an intermittently fragmented render stream, decides
    // whether the save and paste actually succeeded.
    type("\x13");
    await waitFor("saved " + NOTES_REL.replace(".", "\\."), 10000);
    await Bun.sleep(300);

    // Capture the disk content before cleanup — it is the primary oracle.
    try {
      disk = await readFile(join(project, NOTES_REL), "utf8");
    } catch (error) {
      fail(`could not read ${NOTES_REL} after the smoke: ${String(error)}`);
    }
  } finally {
    type("\x03"); await Bun.sleep(300);
    type("\x03"); await Bun.sleep(500);
    try { stdin.end(); } catch { /* exited */ }
    await Promise.race([pump, Bun.sleep(2000)]);
    try { child.kill(); } catch { /* already gone */ }
    await Promise.race([pump, Bun.sleep(500)]);
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\n## Workspace paste PTY smoke @ ${WIDTH}x${HEIGHT} (provider calls: ${providerCalls})`);
  console.log(`\n===== ${NOTES_REL} on disk =====`);
  console.log(JSON.stringify(disk));

  const markerCount = disk.split(PASTE_MARKER).length - 1;
  if (markerCount !== 1) {
    fail(`paste marker appears ${markerCount} time(s) on disk, expected exactly 1 (newline-preserving single insertion)`);
  }
  if (!disk.includes("prefix line")) {
    fail("original prefix line was lost from the file");
  }
  if (providerCalls !== 0) {
    fail(`expected no provider requests, saw ${providerCalls}`);
  }

  if (process.exitCode !== 1) {
    console.log(`\nWorkspace paste PTY smoke passed at ${WIDTH}x${HEIGHT}.`);
  }
}

await main();
