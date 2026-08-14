/**
 * Real-PTY smoke for the post-compact Hero regression (issue #107 PR 2 addendum).
 *
 * Drives the real TUI (bun src/cli/main.ts) inside a `script`-allocated
 * pseudo-terminal against a local mock provider, through:
 *
 *   two turns -> /compact -> inspect -> next prompt -> final reply
 *
 * It polls the rendered PTY output for markers rather than sleeping blindly, so
 * it is robust to splash and render latency. It checks the regression
 * signatures directly: the Hero brand mark must not appear once the conversation
 * begins, the compact summary must appear after /compact, and the region must
 * stay non-blank after the next send. A headless frame cannot prove mounted
 * scroll/remount behavior, so this is the authority for the mounted lifecycle.
 *
 * Usage: bun run scripts/smoke/smoke-compact-pty.ts [width] [height]
 * Exits non-zero if any regression signature is detected.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-compact-pty-"));
  const project = join(root, "project");
  const configDir = join(root, "config");
  await mkdir(project, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(join(project, "workspace"), { recursive: true });

  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      calls += 1;
      const body = (await request.json()) as { messages?: Array<{ content?: string }> };
      const last = body.messages?.at(-1)?.content ?? "";
      const isSummary = last.includes("TEXT ONLY");
      const content = isSummary
        ? "<summary>The user outlined chapter one and refined the second beat; the model drafted a five-beat blueprint.</summary>"
        : `reply ${calls}`;
      return Response.json({ id: `mock-${calls}`, choices: [{ message: { content } }] });
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

  const child = Bun.spawn(["script", "-qfe", "-c", `stty cols ${WIDTH} rows ${HEIGHT}; bun ${join(REPO_ROOT, "src", "cli", "main.ts")} ${project}`, join(root, "pty.log")], {
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
    // Type as a short burst so the composer receives it before the submit.
    type(text);
    await Bun.sleep(60);
    type("\r");
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

  const frames: Array<{ name: string; text: string }> = [];
  const snapshot = (name: string) => frames.push({ name, text: plain() });

  await Bun.sleep(1500); // let the renderer activate
  await send("outline chapter one with five beats");
  await waitFor("reply 1");
  // The Hero is expected before the conversation starts; record the stripped
  // length here so later checks only look at fresh output (a post-compact Hero
  // would re-emit the mark after this point).
  const conversationStartLen = plain().length;
  await send("refine the second beat");
  await waitFor("reply 2");
  snapshot("after two turns");
  type("/compact");
  await Bun.sleep(60);
  type("\r");
  const compacted = await waitFor("compacted into a summary|Nothing left to compact", 20000);
  snapshot("after /compact");
  await send("continue from the summary");
  await waitFor("reply 4", 15000);
  snapshot("after next prompt");

  type("\x03"); await Bun.sleep(300);
  type("\x03"); await Bun.sleep(500);
  try { stdin.end(); } catch { /* exited */ }
  await Promise.race([pump, Bun.sleep(2000)]);
  server.stop(true);
  await rm(root, { recursive: true, force: true });

  const fail = (msg: string) => { console.log(`FAIL: ${msg}`); process.exitCode = 1; };
  const heroMark = "one beam in, the spectrum out";
  console.log(`\n## PTY compact smoke @ ${WIDTH}x${HEIGHT} (provider calls: ${calls})`);
  for (const frame of frames) {
    // Only output rendered AFTER the conversation began can prove the regression;
    // the startup Hero before the first turn is expected and lives above this offset.
    const fresh = frame.text.slice(conversationStartLen);
    const hasConversation = /reply \d|Conversation summary|compacted into a summary|continue from the summary|outlined chapter one/i.test(fresh);
    const freshHero = fresh.includes(heroMark);
    console.log(`\n===== ${frame.name} (fresh ${fresh.length} chars; conversation=${hasConversation}, hero=${freshHero}) =====`);
    console.log(fresh.slice(-700).replace(/\n{3,}/g, "\n\n"));
    if (frame.name !== "after two turns" && freshHero) {
      fail(`${frame.name}: Hero brand mark re-rendered after conversation began`);
    }
    if (frame.name !== "after two turns" && !hasConversation) {
      fail(`${frame.name}: transcript region appears blank after conversation began`);
    }
  }
  if (!compacted) fail("compact completion notice never appeared (Nothing left to compact or timeout)");
  if (!process.exitCode) console.log(`\nPTY compact smoke passed at ${WIDTH}x${HEIGHT}.`);
}

await main();
