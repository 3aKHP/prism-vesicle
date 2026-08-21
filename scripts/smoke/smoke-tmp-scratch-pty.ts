/**
 * Real-PTY smoke for the project-relative `tmp/` scratch root (Issues #137A/#137B).
 *
 * Drives the real TUI (`bun src/cli/main.ts`) inside a `script`-allocated
 * pseudo-terminal against a local mock provider, through:
 *
 *   write tmp/137a-smoke/draft.md -> /artifact (must open the real artifact,
 *   not the scratch draft) -> read the draft -> restart (resume) -> the draft
 *   must survive restart -> /rewind to the writing turn -> the draft must stay
 *   on disk because scratch is deliberately excluded from checkpoints.
 *
 * It polls the rendered PTY output for markers and verifies scratch file state
 * directly on disk, so the evidence is deterministic without provider
 * credentials. A headless frame cannot prove every mounted interaction, so
 * this smoke is the mounted-lifecycle authority for the scratch boundary while
 * the deterministic integration suites cover the path/checkpoint/exclusion
 * contracts in depth.
 *
 * Usage: bun run scripts/smoke/smoke-tmp-scratch-pty.ts [width] [height]
 * Exits non-zero if any scratch-boundary signature is detected.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOCK_ENV,
  SHARED_BASE_PROMPT,
  providersYaml,
  stripAnsi,
} from "./support/pty-smoke";

export {};

const WIDTH = Number(process.argv[2] ?? 100);
const HEIGHT = Number(process.argv[3] ?? 28);
const REPO_ROOT = join(import.meta.dir, "..", "..");
const DRAFT_PATH = "tmp/137a-smoke/draft.md";
const DRAFT_CONTENT = "SCRATCH DRAFT CONTENT\n";
const SEED_CONTENT = "ARTIFACT SEED CONTENT\n";
const ETL_PROMPT = "etl";

const engineProfileYaml = [
  "id: etl", "displayName: Smoke ETL", "protocolVersion: v9.0-state-space",
  "systemPrompt:", "  - assets/prompts/shared/vesicle-base.md", "  - assets/prompts/engines/etl.md",
  "defaultTools:", "  - read_file", "  - write_file",
  "validators: []", "stopGates: []", "stateRoots:", "  - workspace", "",
].join("\n");

function toolCallResponse(id: string, name: string, args: Record<string, unknown>): Response {
  return Response.json({
    id,
    choices: [{
      finish_reason: "tool_calls",
      message: {
        content: "",
        tool_calls: [{ id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  });
}

function textResponse(id: string, content: string): Response {
  return Response.json({ id, choices: [{ message: { content } }] });
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-tmp-scratch-pty-"));
  const project = join(root, "project");
  const configDir = join(root, "config");
  await mkdir(project, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(join(project, "workspace"), { recursive: true });
  await writeFile(join(project, "workspace", "seed.md"), SEED_CONTENT, "utf8");

  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      calls += 1;
      switch (calls) {
        case 1:
          return toolCallResponse("mock-write", "write_file", { path: DRAFT_PATH, content: DRAFT_CONTENT });
        case 2:
          return textResponse("mock-write-done", "scratch draft written");
        case 3:
          return toolCallResponse("mock-read", "read_file", { path: DRAFT_PATH });
        case 4:
          return textResponse("mock-read-done", "scratch draft confirmed");
        case 5:
          return toolCallResponse("mock-read-restart", "read_file", { path: DRAFT_PATH });
        default:
          return textResponse(`mock-reply-${calls}`, "scratch draft survives restart");
      }
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
  env.VESICLE_REDUCED_MOTION = "1"; // freeze the splash so the first turn is not delayed by animation
  env.TERM = "xterm-256color";

  const draftFile = () => join(project, ...DRAFT_PATH.split("/"));

  async function diskState(): Promise<string> {
    try {
      return await readFile(draftFile(), "utf8");
    } catch {
      return "<absent>";
    }
  }

  async function spawnTui(args: string[] = []): Promise<{
    type: (text: string) => void;
    send: (text: string) => Promise<void>;
    plain: () => string;
    waitFor: (marker: string | RegExp, timeoutMs?: number) => Promise<boolean>;
    stop: () => Promise<void>;
  }> {
    const command = [
      "bun",
      shellQuote(join(REPO_ROOT, "src", "cli", "main.ts")),
      ...args.map(shellQuote),
      shellQuote(project),
    ].join(" ");
    const child = Bun.spawn(["script", "-qfe", "-c", `stty cols ${WIDTH} rows ${HEIGHT}; ${command}`, join(root, "pty.log")], {
      cwd: REPO_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    const stdin = child.stdin!;
    let accumulated = "";
    const reader = child.stdout!.getReader();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        accumulated += new TextDecoder().decode(value);
      }
    })();
    const type = (text: string) => { stdin.write(text); stdin.flush(); };
    const send = async (text: string) => {
      type(text);
      await Bun.sleep(60);
      type("\r");
    };
    const plain = () => stripAnsi(accumulated);
    const waitFor = async (marker: string | RegExp, timeoutMs = 15000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const output = plain();
        if (typeof marker === "string" ? output.includes(marker) : marker.test(output)) return true;
        await Bun.sleep(150);
      }
      return false;
    };
    const stop = async () => {
      type("\x03"); await Bun.sleep(300);
      type("\x03"); await Bun.sleep(500);
      try { stdin.end(); } catch { /* exited */ }
      await Promise.race([pump, Bun.sleep(2000)]);
    };
    return { type, send, plain, waitFor, stop };
  }

  let failures = 0;
  const fail = (msg: string) => { console.log(`FAIL: ${msg}`); failures += 1; };

  const tui = await spawnTui();
  // Reduced motion freezes the splash instead of removing it. Wait for both
  // the renderer and provider-ready composer so cold config/catalog loads
  // cannot race the first prompt.
  if (!(await tui.waitFor(/PRISM VESICLE|one beam in, the spectrum out/i, 10000))) {
    fail(`TUI did not reach its startup frame:\n${tui.plain().slice(-800)}`);
  }
  if (!(await tui.waitFor("Type prompt, Enter send", 15000))) {
    fail(`TUI did not reach its provider-ready composer:\n${tui.plain().slice(-800)}`);
  }
  // The startup splash consumes the first keypress; dismiss it so the first
  // prompt is not mangled (same pattern as smoke-malformed-tool-pty).
  await tui.type("\x1b");
  await Bun.sleep(300);

  console.log(`\n## PTY tmp-scratch smoke @ ${WIDTH}x${HEIGHT} (mock server on port ${server.port})`);

  // Turn 1: the model writes the scratch draft through the guarded file tool.
  await tui.send("write a scratch draft under tmp");
  const writeOk = await tui.waitFor("scratch draft written");
  const diskAfterWrite = await diskState();
  if (!writeOk) fail("turn 1 never completed (no 'scratch draft written' marker)");
  if (diskAfterWrite !== DRAFT_CONTENT) fail(`scratch draft not on disk after write (got: ${diskAfterWrite.replace(/\n/g, "\\n")})`);

  // /artifact must open the real artifact (seed.md), never the scratch draft:
  // the viewer title names the opened file, so a scratch leak would title the
  // viewer with tmp/137a-smoke/draft.md. (The transcript legitimately shows
  // the written content through the write_file diff preview.)
  await tui.send("/artifact");
  const artifactOpened = await tui.waitFor(SEED_CONTENT.trim());
  if (!artifactOpened) fail("/artifact did not open the artifact viewer with seed.md");
  const artifactFrame = tui.plain().slice(-4000);
  if (artifactFrame.includes("tmp/137a-smoke/draft.md · md")) fail("/artifact viewer opened the scratch draft instead of the artifact");

  // The Workspace page tree must still show tmp/ as an ordinary project entry.
  if (!artifactFrame.includes("tmp/")) fail("Workspace page tree does not show the tmp/ scratch root");

  // Back to the Chat page, then turn 2: read the draft back.
  await tui.type("\x0f"); // Ctrl+O
  await Bun.sleep(400);
  await tui.send("read the scratch draft");
  const readOk = await tui.waitFor("scratch draft confirmed");
  const transcript = tui.plain();
  if (!readOk) fail("turn 2 never completed (no 'scratch draft confirmed' marker)");
  if (!transcript.includes("SCRATCH DRAFT CONTENT")) fail("turn 2 read result did not surface the scratch content");

  // Restart: the draft must survive without any startup cleanup.
  await tui.stop();
  const diskBeforeRestart = await diskState();
  if (diskBeforeRestart !== DRAFT_CONTENT) fail("scratch draft missing before restart");

  const resumed = await spawnTui(["--resume"]);
  const pickerShown = await resumed.waitFor("Resume Session");
  if (!pickerShown) fail("session picker did not appear on --resume");
  // The frozen startup splash consumes the first keypress; dismiss it first so
  // the picker Enter below is not swallowed.
  await resumed.type(" ");
  await Bun.sleep(300);
  await resumed.type("\r");
  const resumedOk = await resumed.waitFor("Resumed session", 20000);
  if (!resumedOk) {
    console.log("\n===== DEBUG resume frame =====\n" + resumed.plain().slice(-3000));
    fail("session was not resumed after the picker Enter");
  }
  const diskAfterRestart = await diskState();
  if (diskAfterRestart !== DRAFT_CONTENT) fail("scratch draft was auto-cleaned at startup/restart");

  // Turn 3 after restart: the resumed session can still read the draft.
  await resumed.send("read the draft again after restart");
  const restartReadOk = await resumed.waitFor("scratch draft survives restart");
  if (!restartReadOk) {
    console.log("\n===== DEBUG post-restart frame =====\n" + resumed.plain().slice(-3000));
    fail("post-restart read turn never completed");
  }

  // Rewind to the writing turn and verify scratch remains untouched. Since
  // #137B, tmp/ is deliberately excluded from checkpoints and is not
  // rewind-safe; deleting this draft would violate the current contract.
  await resumed.send("/rewind");
  const pickerOpen = await resumed.waitFor("Restore the code and/or conversation", 10000);
  if (!pickerOpen) fail("rewind picker did not open");
  await resumed.type("kkk"); // points: [write turn, read turn, post-restart turn] -> select the write turn
  await Bun.sleep(150);
  await resumed.type("\r");
  const confirmShown = await resumed.waitFor("Confirm you want to restore", 10000);
  if (!confirmShown) fail("rewind restore confirmation did not appear");
  await resumed.type("\r");
  await Bun.sleep(1000);
  const diskAfterRewind = await diskState();
  if (diskAfterRewind !== DRAFT_CONTENT) fail(`scratch draft changed during rewind (got: ${diskAfterRewind.replace(/\n/g, "\\n")})`);

  await resumed.stop();
  server.stop(true);
  await rm(root, { recursive: true, force: true });

  console.log(`\nProvider calls: ${calls}`);
  if (failures === 0) {
    console.log(`PTY tmp-scratch smoke passed at ${WIDTH}x${HEIGHT} (write -> /artifact exclusion -> read -> restart survival -> rewind exclusion).`);
  } else {
    process.exitCode = 1;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

await main();
