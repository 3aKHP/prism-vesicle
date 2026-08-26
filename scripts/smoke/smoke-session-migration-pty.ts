/**
 * Real-PTY regression smoke for startup resume through Harness migration.
 *
 * Drives `vesicle -r` through the picker and two-stage migration review with
 * deliberate pauses between each transition, then verifies that a later user
 * prompt and provider reply are rendered. The pauses make the OpenTUI
 * detach/destroy lifecycle deterministic rather than relying on confirmation
 * timing.
 *
 * This diagnostic uses tmux capture-pane because it is intended for the Linux
 * PTY acceptance lane; Windows dogfood should run the equivalent flow in the
 * real Windows terminal.
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
} from "./support/pty-smoke";
import { createSessionStore } from "../../src/core/session/store";

export {};

const REPO_ROOT = join(import.meta.dir, "..", "..");

const oldIdentity = {
  packId: "prism-engine-v10",
  packVersion: "10.3.0-alpha.1",
  sourceCommit: "0".repeat(40),
  manifestSha256: "1".repeat(64),
  adapterId: "vesicle-v1",
  adapterVersion: "1.1.0",
  adapterHash: "2".repeat(64),
};

async function tmux(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, error, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed (exit ${exitCode}): ${error.trim() || "no stderr"}`);
  }
  return out;
}

async function capture(session: string): Promise<string> {
  return tmux("capture-pane", "-t", session, "-p");
}

async function waitFor(session: string, marker: string | RegExp, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await capture(session);
    if (typeof marker === "string" ? frame.includes(marker) : marker.test(frame)) return true;
    await Bun.sleep(200);
  }
  return false;
}

function requireMarker(label: string, value: boolean): void {
  if (!value) throw new Error(`PTY migration smoke failed: ${label}`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-repro-tmux-"));
  const project = join(root, "project");
  const configDir = join(root, "config");
  let server: ReturnType<typeof Bun.serve> | undefined;
  let ts: string | undefined;
  try {
    await mkdir(project, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(join(project, "assets", "prompts", "shared"), { recursive: true });
    await mkdir(join(project, "assets", "prompts", "engines"), { recursive: true });
    await mkdir(join(project, "assets", "engines"), { recursive: true });
    await writeFile(join(project, "assets", "prompts", "shared", "vesicle-base.md"), SHARED_BASE_PROMPT, "utf8");
    await writeFile(join(project, "assets", "prompts", "engines", "etl.md"), ETL_PROMPT, "utf8");
    await writeFile(join(project, "assets", "engines", "etl.profile.yaml"), engineProfileYaml, "utf8");

    server = Bun.serve({
      port: 0,
      fetch: () => Response.json({
        id: "mock",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "mock reply after resume" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
      }),
    });
    await writeFile(join(configDir, "providers.yaml"), providersYaml(server.port ?? 0), "utf8");
    await writeFile(join(configDir, ".env"), MOCK_ENV, "utf8");

    const sessionId = "2026-08-20T00-00-00-000Z-oldsession";
    const store = await createSessionStore(project, sessionId);
    await store.append({ role: "system", content: "base", metadata: { engine: "etl", harness: oldIdentity } });
    await store.append({ role: "user", content: "hello from old session" });
    await store.append({ role: "assistant", content: "old reply", metadata: { engine: "etl", model: "mock-model" } });

    ts = `repro${Date.now() % 100000}`;
    const cmd = `cd ${project} && VESICLE_PROVIDERS_FILE=${join(configDir, "providers.yaml")} VESICLE_REDUCED_MOTION=1 TERM=xterm-256color bun ${join(REPO_ROOT, "src", "cli", "main.ts")} -r .`;
    await tmux("new-session", "-d", "-s", ts, "-x", "100", "-y", "28", cmd);

    // The first key owns and dismisses the startup splash; do that explicitly so
    // subsequent Enter presses belong to the picker/migration flow.
    await Bun.sleep(1000);
    await tmux("send-keys", "-t", ts, "x");
    const pickerShown = await waitFor(ts, "Resume Session", 20000);
    console.log("picker shown:", pickerShown);
    requireMarker("startup picker", pickerShown);
    await tmux("send-keys", "-t", ts, "Enter");
    const panelShown = await waitFor(ts, "Migrate session Harness baseline", 20000);
    console.log("migration panel shown:", panelShown);
    requireMarker("migration review", panelShown);
    // Deliberately pause between each stage: this rules out confirmation-key
    // timing and makes the remount sequence deterministic.
    await Bun.sleep(1500);
    await tmux("send-keys", "-t", ts, "Enter");
    await waitFor(ts, "(2/2)", 5000);
    await Bun.sleep(1500);
    await tmux("send-keys", "-t", ts, "Enter");
    const resumed = await waitFor(ts, /resumed\s+00-00-00|session migrated to/, 20000);
    console.log("resume completed:", resumed);
    requireMarker("post-migration resume", resumed);
    await Bun.sleep(2000);

    const frame = await capture(ts);
    console.log("=========== CLEAN FINAL FRAME ===========");
    console.log(frame);
    console.log("=========================================");
    console.log("transcript visible:", frame.includes("hello from old session"));
    console.log("picker still open:", frame.includes("Resume Session"));
    console.log("hero visible:", frame.includes("one beam in"));
    requireMarker("restored Chat surface", frame.includes("Restored engine etl from session."));
    requireMarker("Hero remains hidden after resume", !frame.includes("one beam in"));

    await tmux("send-keys", "-t", ts, "ping after resume");
    await Bun.sleep(1000);
    await tmux("send-keys", "-t", ts, "Enter");
    await waitFor(ts, "mock reply after resume", 10000);
    await Bun.sleep(2000);
    const frame2 = await capture(ts);
    console.log("=========== FRAME AFTER NEW PROMPT ===========");
    console.log(frame2);
    console.log("==============================================");
    console.log("user prompt rendered:", frame2.includes("ping after resume"));
    console.log("mock reply rendered:", frame2.includes("mock reply after resume"));
    requireMarker("post-resume user prompt", frame2.includes("ping after resume"));
    requireMarker("post-resume provider reply", frame2.includes("mock reply after resume"));
  } finally {
    if (ts) {
      try { await tmux("kill-session", "-t", ts); } catch { /* session already exited */ }
    }
    server?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
