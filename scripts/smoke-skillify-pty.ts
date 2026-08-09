/**
 * Bounded real-PTY acceptance for the bundled `skillify` workflow.
 *
 * A local deterministic provider drives the mounted TUI through Host Skill
 * activation, guarded draft authoring, wrapper inspection, validation, explicit
 * project publication, a same-session activation refusal, and discovery plus a
 * resource read from a fresh session. The draft must remain on disk and neither
 * transcript may expose the self-invocation executable/entrypoint paths.
 */
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ETL_PROMPT, MOCK_ENV, SHARED_BASE_PROMPT, providersYaml, stripAnsi } from "./support/pty-smoke";

export {};

const WIDTH = Number(process.argv[2] ?? 80);
const HEIGHT = Number(process.argv[3] ?? 24);
const REPO_ROOT = join(import.meta.dir, "..");
const NAME = "pty-published";
const SOURCE = `tmp/skillify/${NAME}`;
const SKILL_MD = `---\nname: ${NAME}\ndescription: "复用已验证的 PTY 工作流"\n---\n\n# PTY published\n\nFollow the verified workflow.\n`;
const GUIDE = "PTY RESOURCE MARKER 你好\n";

const engineProfileYaml = [
  "id: etl", "displayName: Skillify PTY", "protocolVersion: v9.0-state-space",
  "systemPrompt:", "  - assets/prompts/shared/vesicle-base.md", "  - assets/prompts/engines/etl.md",
  "defaultTools:", "  - create_file", "  - create_directory", "  - activate_skill", "  - read_skill_resource", "  - run_skill_script",
  "validators: []", "stopGates: []", "stateRoots:", "  - workspace", "",
].join("\n");

function toolCallResponse(id: string, name: string, args: Record<string, unknown>): Response {
  return Response.json({
    id,
    choices: [{
      finish_reason: "tool_calls",
      message: { content: "", tool_calls: [{ id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
    }],
  });
}

function textResponse(id: string, content: string): Response {
  return Response.json({ id, choices: [{ message: { content } }] });
}

type Pty = {
  send: (text: string) => Promise<void>;
  waitFor: (marker: string, timeoutMs?: number) => Promise<boolean>;
  plain: () => string;
  stop: () => Promise<void>;
};

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-skillify-pty-"));
  const project = join(root, "project");
  const configDir = join(root, "config");
  await mkdir(join(project, "workspace"), { recursive: true });
  await mkdir(configDir, { recursive: true });

  let launchCommand = `bun ${quote(join(REPO_ROOT, "src", "cli", "main.ts"))}`;
  const requestedBinary = process.env.VESICLE_BIN;
  if (requestedBinary) {
    if (!(await Bun.file(requestedBinary).exists())) throw new Error(`VESICLE_BIN not found: ${requestedBinary}`);
    const release = join(root, "release");
    const binary = join(release, "prism-vesicle");
    await mkdir(release, { recursive: true });
    await cp(requestedBinary, binary);
    await cp(join(REPO_ROOT, "assets"), join(release, "assets"), { recursive: true });
    await cp(join(REPO_ROOT, "host-assets"), join(release, "host-assets"), { recursive: true });
    await copyFile(join(REPO_ROOT, "harness-manifest.json"), join(release, "harness-manifest.json"));
    launchCommand = quote(binary);
  }

  const requests: unknown[] = [];
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      calls += 1;
      switch (calls) {
        case 1: return toolCallResponse("activate-skillify", "activate_skill", { name: "skillify" });
        case 2: return toolCallResponse("inspect-wrapper", "read_skill_resource", { skill: "skillify", path: "scripts/publish_skill.sh" });
        case 3: return toolCallResponse("create-draft", "create_directory", { path: SOURCE });
        case 4: return toolCallResponse("create-skill-md", "create_file", { path: `${SOURCE}/SKILL.md`, content: SKILL_MD });
        case 5: return toolCallResponse("create-references", "create_directory", { path: `${SOURCE}/references` });
        case 6: return toolCallResponse("create-guide", "create_file", { path: `${SOURCE}/references/guide.md`, content: GUIDE });
        case 7: return toolCallResponse("validate", "run_skill_script", { skill: "skillify", path: "scripts/publish_skill.sh", args: ["validate", SOURCE] });
        case 8: return toolCallResponse("publish", "run_skill_script", { skill: "skillify", path: "scripts/publish_skill.sh", args: ["publish", SOURCE, "project"] });
        case 9: return toolCallResponse("frozen-catalog", "activate_skill", { name: NAME });
        case 10: return textResponse("first-done", "SKILLIFY FIRST SESSION DONE");
        case 11: return toolCallResponse("fresh-activate", "activate_skill", { name: NAME });
        case 12: return toolCallResponse("fresh-read", "read_skill_resource", { skill: NAME, path: "references/guide.md" });
        default: return textResponse("fresh-done", "SKILLIFY FRESH SESSION DONE");
      }
    },
  });

  // Keep the complete bundled Skill catalog available; this smoke exercises
  // skillify itself rather than catalog-budget omission behavior.
  await writeFile(join(configDir, "providers.yaml"), providersYaml(server.port ?? 0, 32_000), "utf8");
  await writeFile(join(configDir, ".env"), MOCK_ENV, "utf8");
  await mkdir(join(project, "assets", "prompts", "shared"), { recursive: true });
  await mkdir(join(project, "assets", "prompts", "engines"), { recursive: true });
  await mkdir(join(project, "assets", "engines"), { recursive: true });
  await writeFile(join(project, "assets", "prompts", "shared", "vesicle-base.md"), SHARED_BASE_PROMPT, "utf8");
  await writeFile(join(project, "assets", "prompts", "engines", "etl.md"), ETL_PROMPT, "utf8");
  await writeFile(join(project, "assets", "engines", "etl.profile.yaml"), engineProfileYaml, "utf8");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VESICLE_PROVIDERS_FILE: join(configDir, "providers.yaml"),
    // An absent file exercises the product defaults: MOMENTUM with shell_exec
    // disabled. run_skill_script must remain usable without either override.
    VESICLE_PERMISSIONS_FILE: join(configDir, "permissions.yaml"),
    VESICLE_REDUCED_MOTION: "1",
    TERM: "xterm-256color",
  };

  const start = async (): Promise<Pty> => {
    const command = `stty cols ${WIDTH} rows ${HEIGHT}; ${launchCommand} ${quote(project)}`;
    const child = Bun.spawn(["script", "-qfe", "-c", command, join(root, `pty-${calls}.log`)], {
      cwd: REPO_ROOT,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdin = child.stdin!;
    let accumulated = "";
    const pump = (async () => {
      const reader = child.stdout!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        accumulated += new TextDecoder().decode(value);
      }
    })();
    const type = (text: string) => { stdin.write(text); stdin.flush(); };
    const send = async (text: string) => { type(text); await Bun.sleep(80); type("\r"); };
    const plain = () => stripAnsi(accumulated);
    const waitFor = async (marker: string, timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (plain().includes(marker)) return true;
        await Bun.sleep(150);
      }
      return false;
    };
    const stop = async () => {
      type("\x03"); await Bun.sleep(300); type("\x03"); await Bun.sleep(500);
      try { stdin.end(); } catch { /* already exited */ }
      await Promise.race([pump, Bun.sleep(2_000)]);
    };
    await Bun.sleep(2_500);
    type("\x1b");
    await Bun.sleep(300);
    return { send, waitFor, plain, stop };
  };

  const failures: string[] = [];
  const check = (condition: boolean, message: string) => { if (!condition) failures.push(message); };

  const first = await start();
  await first.send("Turn this proven workflow into a project Skill named pty-published and publish it to the project.");
  check(await first.waitFor("SKILLIFY FIRST SESSION DONE"), "first session did not complete the skillify workflow");
  const firstTranscript = first.plain();
  await first.stop();

  const draftBody = await readFile(join(project, ...SOURCE.split("/"), "SKILL.md"), "utf8").catch(() => "");
  const publishedBody = await readFile(join(project, ".agents", "skills", NAME, "SKILL.md"), "utf8").catch(() => "");
  check(draftBody === SKILL_MD, "draft was changed or removed after publication");
  check(publishedBody === SKILL_MD, "project publication is missing or not byte-exact");

  const firstRequests = JSON.stringify(requests.slice(0, 10));
  check(
    (firstRequests.includes("not available") || firstRequests.includes("not in the active Skill catalog") || firstRequests.includes("Unknown skill"))
      && firstRequests.includes(NAME),
    "current session did not refuse activation from its frozen catalog",
  );

  const fresh = await start();
  await fresh.send("Activate the new project Skill and read its guide.");
  check(await fresh.waitFor("SKILLIFY FRESH SESSION DONE"), "fresh session did not discover and use the published Skill");
  const freshTranscript = fresh.plain();
  await fresh.stop();

  const freshRequests = JSON.stringify(requests.slice(10));
  check(freshRequests.includes(GUIDE.trim()), "fresh-session resource content did not return through read_skill_resource");
  for (const sensitive of [root, process.execPath, join(REPO_ROOT, "src", "cli", "main.ts")]) {
    check(!firstTranscript.includes(sensitive) && !freshTranscript.includes(sensitive), `transcript exposed an absolute self-invocation path: ${sensitive}`);
  }

  server.stop(true);
  await rm(root, { recursive: true, force: true });
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PTY skillify smoke passed at ${WIDTH}x${HEIGHT}: draft -> validate -> project publish -> frozen catalog -> fresh-session discovery/resource.`);
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

await main();
