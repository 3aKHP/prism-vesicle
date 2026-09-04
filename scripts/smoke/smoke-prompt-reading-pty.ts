/** Real Linux PTY acceptance for #315; only a local controlled provider is used. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOCK_ENV, providersYaml, engineProfileYaml } from "./support/pty-smoke";

const repo = join(import.meta.dir, "..", "..");
const longText = Array.from({ length: 35 }, (_, i) => `READING-ROW-${i + 1}: inspect this detail before deciding`).join("\n");
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
async function tmux(...args: string[]): Promise<string> {
  const process = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, error, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exit) throw new Error(`tmux failed: ${error}`);
  return out;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "vesicle-reading-pty-"));
  const project = join(root, "project");
  const config = join(root, "config");
  const session = `reading-${Date.now()}`;
  let calls = 0;
  let started = false;
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls += 1;
      const tool = calls === 1 ? { name: "request_confirmation", args: { gate: "blueprint", summary: longText } }
        : calls === 2 ? { name: "ask_user_question", args: { header: "Reading question", question: longText, options: [
          { label: "First", description: "first option" }, { label: "Second", description: `${longText}\nOPTION-TAIL` },
        ] } }
          : calls === 3 ? { name: "shell_exec", args: { command: `# ${longText.replaceAll("\n", "\n# ")}\nprintf never-executed` } } : null;
      return Response.json({ id: `reading-${calls}`, choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", message: {
        role: "assistant", content: tool ? "" : "READING-SMOKE-DONE",
        ...(tool ? { tool_calls: [{ id: `call-${calls}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : {}),
      } }] });
    },
  });
  const capture = () => tmux("capture-pane", "-t", session, "-p");
  async function waitFor(marker: string, timeout = 15000): Promise<string> {
    const deadline = Date.now() + timeout;
    let frame = "";
    while (Date.now() < deadline) {
      frame = await capture();
      if (frame.includes(marker)) return frame;
      await Bun.sleep(100);
    }
    throw new Error(`Missing ${marker} (provider calls ${calls}):\n${frame}`);
  }
  async function key(...keys: string[]) {
    await tmux("send-keys", "-t", session, ...keys);
    await Bun.sleep(150);
  }
  function check(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
  }
  try {
    await mkdir(config, { recursive: true });
    await mkdir(join(project, "assets", "prompts", "shared"), { recursive: true });
    await mkdir(join(project, "assets", "prompts", "engines"), { recursive: true });
    await mkdir(join(project, "assets", "engines"), { recursive: true });
    await writeFile(join(project, "assets", "prompts", "shared", "vesicle-base.md"), "base");
    await writeFile(join(project, "assets", "prompts", "engines", "etl.md"), "etl");
    await writeFile(join(project, "assets", "engines", "etl.profile.yaml"), engineProfileYaml.replace("stopGates: []", "stopGates:\n  - blueprint"));
    await writeFile(join(config, "providers.yaml"), providersYaml(server.port!));
    await writeFile(join(config, ".env"), MOCK_ENV);
    await writeFile(join(config, "settings.yaml"), "sessionTitle: off\n");
    await writeFile(join(config, "permissions.yaml"), "version: 1\ndefaultMode: MOMENTUM\nshellExec: true\n");
    const launch = `VESICLE_PROVIDERS_FILE=${quote(join(config, "providers.yaml"))} VESICLE_REDUCED_MOTION=1 TERM=xterm-256color ${quote(process.execPath)} ${quote(join(repo, "src", "cli", "main.ts"))} ${quote(project)}`;
    await tmux("new-session", "-d", "-s", session, "-x", "80", "-y", "24", launch);
    started = true;
    await Bun.sleep(1500);
    await key("Escape");
    await waitFor("Type prompt");
    await Bun.sleep(500);
    await key("inspect");
    await waitFor("inspect");
    await key("Enter");
    await waitFor("Stop Gate");
    await key("keep-note");
    await key("Tab");
    await waitFor("Tab/Enter/Esc back");
    await key("End");
    await waitFor("READING-ROW-35");
    await key("C-o");
    await waitFor("Ctrl+O to answer");
    await key("C-o");
    await waitFor("READING-ROW-35");
    await tmux("resize-window", "-t", session, "-x", "80", "-y", "16");
    await Bun.sleep(500);
    await waitFor("Tab/Enter/Esc back");
    await key("End");
    await waitFor("READING-ROW-35");
    await key("Enter");
    await waitFor("keep-note");
    check(calls === 1, "Returning from gate reading submitted a decision");
    await key("Enter");
    await waitFor("Reading question");
    await key("Tab");
    await key("End");
    await waitFor("OPTION-TAIL");
    await key("Escape");
    check(calls === 2, "Returning from question reading answered it");
    await key("Enter");
    await waitFor("Permission required");
    await key("Down");
    await key("reject-note");
    await key("Tab");
    await key("End");
    await waitFor("never-executed");
    await tmux("resize-window", "-t", session, "-x", "120", "-y", "40");
    await Bun.sleep(500);
    await waitFor("never-executed");
    await key("Escape");
    await waitFor("reject-note");
    check(calls === 3, "Returning from permission reading resolved it");
    await key("Enter");
    await waitFor("READING-SMOKE-DONE");
    check(calls === 4, `Unexpected provider call count ${calls}`);
    console.log("Prompt reading PTY passed: gate, question, shell rejection; 80x24, 80x16, 120x40; Ctrl+O, resize, notes and return isolation.");
  } finally {
    if (started) await tmux("kill-session", "-t", session).catch(() => undefined);
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
