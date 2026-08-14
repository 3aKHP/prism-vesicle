/**
 * Real-PTY smoke for Issue #133 malformed tool arguments.
 *
 * A mock provider returns one truncated write_file argument string. The smoke
 * proves the 80-column TUI renders a tool failure (not a provider parse error),
 * the continuation receives replay-safe arguments plus the paired failure,
 * and durable history remains resumable without a failed-turn marker.
 */
import { copyFile, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ETL_PROMPT, MOCK_ENV, SHARED_BASE_PROMPT, providersYaml, stripAnsi } from "./support/pty-smoke";

export {};

const width = Number(process.argv[2] ?? 80);
const height = Number(process.argv[3] ?? 24);
const repoRoot = join(import.meta.dir, "..", "..");
const engineProfile = [
  "id: etl", "displayName: Smoke ETL", "protocolVersion: v9.0-state-space",
  "systemPrompt:", "  - assets/prompts/shared/vesicle-base.md", "  - assets/prompts/engines/etl.md",
  "defaultTools:", "  - write_file", "validators: []", "stopGates: []", "stateRoots:",
  "  - workspace", "",
].join("\n");

type MockMessage = {
  role?: string;
  content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ function?: { arguments?: string } }>;
};

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-malformed-tool-pty-"));
  const project = join(root, "project");
  const configDir = join(root, "config");
  const releaseDir = process.env.VESICLE_BIN ? join(root, "release") : undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await mkdir(join(project, "workspace"), { recursive: true });
    await mkdir(configDir, { recursive: true });

    let calls = 0;
    let continuationValid = false;
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        calls += 1;
        const body = await request.json() as { messages?: MockMessage[] };
        if (calls === 1) {
          return Response.json({
            id: "malformed-1",
            choices: [{ message: { content: "", tool_calls: [{
              id: "call-truncated",
              type: "function",
              function: {
                name: "write_file",
                arguments: "{\"path\":\"workspace/bad.md\",\"content\":\"truncated",
              },
            }] } }],
          });
        }
        const assistant = body.messages?.find((message) => message.role === "assistant" && message.tool_calls);
        const tool = body.messages?.find((message) => message.role === "tool" && message.tool_call_id === "call-truncated");
        continuationValid = assistant?.tool_calls?.[0]?.function?.arguments === "{}"
          && typeof tool?.content === "string"
          && tool.content.includes('"ok":false');
        return Response.json({ id: "malformed-2", choices: [{ message: { content: "Recovered after tool failure." } }] });
      },
    });

    await writeFile(join(configDir, "providers.yaml"), providersYaml(server.port ?? 0), "utf8");
    await writeFile(join(configDir, ".env"), MOCK_ENV, "utf8");
    await mkdir(join(project, "assets", "prompts", "shared"), { recursive: true });
    await mkdir(join(project, "assets", "prompts", "engines"), { recursive: true });
    await mkdir(join(project, "assets", "engines"), { recursive: true });
    await writeFile(join(project, "assets", "prompts", "shared", "vesicle-base.md"), SHARED_BASE_PROMPT, "utf8");
    await writeFile(join(project, "assets", "prompts", "engines", "etl.md"), ETL_PROMPT, "utf8");
    await writeFile(join(project, "assets", "engines", "etl.profile.yaml"), engineProfile, "utf8");

    const launch = await prepareLaunch(releaseDir);
    const env = { ...process.env,
      VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml"),
      VESICLE_REDUCED_MOTION: "1",
      TERM: "xterm-256color",
    };
    child = Bun.spawn(["script", "-qfe", "-c", `stty cols ${width} rows ${height}; ${launch.command} ${shellQuote(project)}`, join(root, "pty.log")], {
      cwd: launch.cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    });
    if (!child.stdin || typeof child.stdin === "number") throw new Error("PTY stdin pipe was not created");
    if (!(child.stdout instanceof ReadableStream)) throw new Error("PTY stdout pipe was not created");
    const stdin = child.stdin;
    const stdout = child.stdout;
    let output = "";
    const pump = (async () => {
      for await (const chunk of stdout) output += new TextDecoder().decode(chunk);
    })();
    const startupDeadline = Date.now() + 10000;
    while (!/PRISM VESICLE|one beam in, the spectrum out/i.test(stripAnsi(output)) && Date.now() < startupDeadline) {
      await Bun.sleep(100);
    }
    if (!/PRISM VESICLE|one beam in, the spectrum out/i.test(stripAnsi(output))) {
      throw new Error(`TUI did not reach its startup frame:\n${stripAnsi(output).slice(-800)}`);
    }
    stdin.write("\x1b"); stdin.flush();
    await Bun.sleep(350);
    stdin.write("write the requested file"); stdin.flush();
    await Bun.sleep(80);
    stdin.write("\r"); stdin.flush();

    const deadline = Date.now() + 15000;
    while (!stripAnsi(output).includes("Recovered after tool failure.") && Date.now() < deadline) await Bun.sleep(100);
    if (!stripAnsi(output).includes("Recovered after tool failure.")) {
      throw new Error(`TUI did not render the recovered reply:\n${stripAnsi(output).slice(-1200)}`);
    }
    stdin.write("\x03"); stdin.flush(); await Bun.sleep(250);
    stdin.write("\x03"); stdin.flush(); await Bun.sleep(350);
    try { stdin.end(); } catch { /* already exited */ }
    await Promise.race([pump, Bun.sleep(1500)]);

    const plain = stripAnsi(output);
    const sessionsDir = join(project, ".vesicle", "sessions");
    const sessionName = (await readdir(sessionsDir)).find((name) => name.endsWith(".jsonl"));
    if (!sessionName) throw new Error("session JSONL was not created");
    const sessionFile = join(sessionsDir, sessionName);
    const records = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const assistant = records.find((record) => record.role === "assistant" && record.metadata?.providerResponseId === "malformed-1");
    const failedTool = records.find((record) => record.role === "tool" && record.metadata?.toolCallId === "call-truncated");
    const failures: string[] = [];
    if (calls !== 2) failures.push(`expected 2 provider calls, got ${calls}`);
    if (!continuationValid) failures.push("continuation did not contain normalized arguments and paired failed result");
    if (!plain.includes("Tool arguments must be valid JSON object")) failures.push("80-column TUI did not render the tool failure");
    if (!plain.includes("Recovered after tool failure.")) failures.push("80-column TUI did not render the recovered reply");
    if (/unparseable response|Cannot serialize malformed tool-call arguments/i.test(plain)) failures.push("TUI misclassified the tool failure as a provider parse failure");
    if (assistant?.metadata?.toolCalls?.[0]?.arguments !== "{}") failures.push("durable assistant arguments were not normalized");
    if (failedTool?.metadata?.ok !== false || failedTool?.metadata?.reason !== "malformed-tool-arguments") failures.push("durable failed tool result is missing");
    if (records.some((record) => record.metadata?.kind === "failed-turn")) failures.push("mid-loop malformed call appended a failed-turn marker");
    if (await Bun.file(join(project, "workspace", "bad.md")).exists()) failures.push("malformed write_file was executed");
    if (failures.length > 0) throw new Error(failures.join("; "));
    console.log(`Malformed-tool PTY smoke passed at ${width}x${height} (${launch.label}, 2 provider calls).`);
  } finally {
    server?.stop(true);
    child?.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function prepareLaunch(releaseDir: string | undefined): Promise<{ label: string; command: string; cwd: string }> {
  if (!process.env.VESICLE_BIN || !releaseDir) {
    return { label: "source", command: `bun ${shellQuote(join(repoRoot, "src", "cli", "main.ts"))}`, cwd: repoRoot };
  }
  await mkdir(releaseDir, { recursive: true });
  const binary = join(releaseDir, "prism-vesicle");
  await cp(process.env.VESICLE_BIN, binary);
  await cp(join(repoRoot, "assets"), join(releaseDir, "assets"), { recursive: true });
  await cp(join(repoRoot, "host-assets"), join(releaseDir, "host-assets"), { recursive: true });
  await copyFile(join(repoRoot, "harness-manifest.json"), join(releaseDir, "harness-manifest.json"));
  return { label: "Linux ELF", command: shellQuote(binary), cwd: releaseDir };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

await main();
