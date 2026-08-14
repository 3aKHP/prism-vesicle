/**
 * Real-PTY smoke for issue #131: `/skill` as the FIRST input of a fresh session.
 *
 * Drives the real TUI inside a `script`-allocated pseudo-terminal against a
 * local mock provider and leads a brand-new session with a Skill activation
 * through all three command surfaces:
 *
 *   /skill vesicle-docs                    (activate-and-invoke)
 *   /skill vesicle-docs --context-only     (load-only, provider deferred)
 *   /skill  + picker selection             (bare picker, context-only)
 *
 * Before the fix, the host path wrote the activation record before any session
 * header existed, so the first provider turn rejected the session with "Session
 * Harness identity does not match the active verified project baseline."
 *
 * Launch target (issue #131 acceptance criterion 8 — npm artifact or Linux ELF):
 *   - default: `bun src/cli/main.ts` (source; repo root carries the bundled
 *     harness, assets, and host-assets);
 *   - VESICLE_BIN=<path>: stages the real release shape (binary + assets +
 *     host-assets + harness-manifest.json beside the executable, mirroring
 *     scripts/smoke/smoke-binary.ts) and drives the compiled artifact. Point it at a
 *     `bun run build:exe` ELF or an installed npm binary.
 *
 * Assertions are deliberately rendering-independent. The activation card is a
 * transient in-memory message that a fast mock provider can replace before a
 * frame commits, so the smoke proves the fix through durable state and precise
 * provider-request accounting instead:
 *   - the PTY output never contains the Harness identity error;
 *   - invoke makes exactly one provider request; context-only/picker make ZERO
 *     requests until a normal follow-up prompt, then exactly one;
 *   - the persisted session JSONL starts with a system header carrying a
 *     Harness identity, followed by a durable skill-activation record in the
 *     expected mode, and (for the deferred paths) the follow-up user + assistant
 *     records actually land.
 *
 * Commands are typed the way smoke-workspace-status-pty.ts does (slash alone,
 * name char-by-char, Tab-complete, then the argument): a raw burst or a raw
 * space to dismiss the completion menu mis-parses under a `script` PTY.
 *
 * Usage:
 *   bun run scripts/smoke/smoke-skill-first-input-pty.ts [width] [height]
 *   VESICLE_BIN=./prism-vesicle bun run scripts/smoke/smoke-skill-first-input-pty.ts
 * Exits non-zero if the identity guard fires, the request accounting is wrong,
 * or the durable ordering is wrong.
 */
import { copyFile, cp, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ETL_PROMPT,
  MOCK_ENV,
  SHARED_BASE_PROMPT,
  providersYaml,
  stripAnsi,
} from "./support/pty-smoke";

export {};

const WIDTH = Number(process.argv[2] ?? 80);
const HEIGHT = Number(process.argv[3] ?? 24);
const REPO_ROOT = join(import.meta.dir, "..", "..");
const IDENTITY_ERROR = "Harness identity does not match";
const FOLLOW_UP_PROMPT = "continue now";

// The shared smoke profile omits the Skill tools; host activation requires the
// engine profile to declare activate_skill for the catalog to be eligible.
const skillEngineProfileYaml = [
  "id: etl", "displayName: Smoke ETL", "protocolVersion: v9.0-state-space",
  "systemPrompt:", "  - assets/prompts/shared/vesicle-base.md", "  - assets/prompts/engines/etl.md",
  "defaultTools:", "  - read_file", "  - activate_skill", "  - read_skill_resource", "  - run_skill_script",
  "validators: []", "stopGates: []", "stateRoots:", "  - workspace", "",
].join("\n");

type SessionRecord = { role: string; content?: string; metadata?: Record<string, unknown> };

type LaunchTarget = {
  label: string;
  innerCommand: (project: string) => string;
  cwd: string;
  cleanup: () => Promise<void>;
};

const shellQuote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;

/** Source launch by default; VESICLE_BIN stages and drives a release artifact. */
async function prepareTarget(): Promise<LaunchTarget> {
  const bin = process.env.VESICLE_BIN;
  if (!bin) {
    return {
      label: "source (bun src/cli/main.ts)",
      innerCommand: (project) => `bun ${shellQuote(join(REPO_ROOT, "src", "cli", "main.ts"))} ${shellQuote(project)}`,
      cwd: REPO_ROOT,
      cleanup: async () => {},
    };
  }
  if (!(await Bun.file(bin).exists())) throw new Error(`VESICLE_BIN not found at ${bin}. Build it first (bun run build:exe).`);
  const root = await mkdtemp(join(tmpdir(), "vesicle-skill-release-"));
  const release = join(root, "release");
  await mkdir(release, { recursive: true });
  const binary = join(release, `prism-vesicle${process.platform === "win32" ? ".exe" : ""}`);
  await cp(bin, binary);
  await cp(join(REPO_ROOT, "assets"), join(release, "assets"), { recursive: true });
  await cp(join(REPO_ROOT, "host-assets"), join(release, "host-assets"), { recursive: true });
  await copyFile(join(REPO_ROOT, "harness-manifest.json"), join(release, "harness-manifest.json"));
  return {
    label: `release artifact (${bin})`,
    innerCommand: (project) => `${shellQuote(binary)} ${shellQuote(project)}`,
    cwd: release,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

type PtySession = {
  type: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  typeSlow: (text: string) => Promise<void>;
  submit: (text: string) => Promise<void>;
  waitFor: (marker: string | RegExp, timeoutMs?: number) => Promise<boolean>;
  waitForRecord: (predicate: (records: SessionRecord[]) => boolean, timeoutMs?: number) => Promise<boolean>;
  calls: () => number;
  readRecords: () => Promise<SessionRecord[]>;
  plain: () => string;
  teardown: () => Promise<void>;
};

async function startSession(target: LaunchTarget): Promise<PtySession> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-skill-first-pty-"));
  const project = join(root, "project");
  const configDir = join(root, "config");
  await mkdir(project, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(join(project, "workspace"), { recursive: true });

  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      calls += 1;
      return Response.json({ id: `mock-${calls}`, choices: [{ message: { content: "reply 1" } }] });
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
  await writeFile(join(enginesDir, "etl.profile.yaml"), skillEngineProfileYaml, "utf8");

  const env: NodeJS.ProcessEnv = { ...process.env };
  env.VESICLE_PROVIDERS_FILE = join(configDir, "providers.yaml");
  env.VESICLE_REDUCED_MOTION = "1";
  env.TERM = "xterm-256color";

  const child = Bun.spawn(["script", "-qfe", "-c", `stty cols ${WIDTH} rows ${HEIGHT}; ${target.innerCommand(project)}`, join(root, "pty.log")], {
    cwd: target.cwd,
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
  const sleep = (ms: number) => Bun.sleep(ms);
  const typeSlow = async (text: string) => { for (const ch of text) { type(ch); await sleep(40); } };
  const submit = async (text: string) => { await typeSlow(text); await sleep(150); type("\r"); };
  const plain = () => stripAnsi(accumulated);
  const waitFor = async (marker: string | RegExp, timeoutMs = 25000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (new RegExp(marker).test(plain())) return true;
      await sleep(150);
    }
    return false;
  };
  const readRecords = async (): Promise<SessionRecord[]> => {
    const dir = join(project, ".vesicle", "sessions");
    const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => file.endsWith(".jsonl"));
    const records: SessionRecord[] = [];
    for (const file of files) {
      const text = await Bun.file(join(dir, file)).text();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        records.push(JSON.parse(line) as SessionRecord);
      }
    }
    return records;
  };
  const waitForRecord = async (predicate: (records: SessionRecord[]) => boolean, timeoutMs = 25000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(await readRecords())) return true;
      await sleep(150);
    }
    return false;
  };
  const teardown = async () => {
    type("\x03"); await sleep(300);
    type("\x03"); await sleep(500);
    try { stdin.end(); } catch { /* exited */ }
    await Promise.race([pump, sleep(2000)]);
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  };

  await sleep(2800); // let the renderer + composer fully activate
  return { type, sleep, typeSlow, submit, waitFor, waitForRecord, calls: () => calls, readRecords, plain, teardown };
}

const hasActivation = (records: SessionRecord[]) => records.some((record) => record.metadata?.kind === "skill-activation");

async function main(): Promise<void> {
  const failures: string[] = [];
  const check = (scenario: string, condition: boolean, message: string) => {
    if (!condition) failures.push(`${scenario}: ${message}`);
  };
  const target = await prepareTarget();
  console.log(`\n## PTY skill-first-input smoke @ ${WIDTH}x${HEIGHT} — ${target.label}`);

  // --- invoke: /skill vesicle-docs -----------------------------------------
  {
    const name = "invoke: /skill vesicle-docs";
    const s = await startSession(target);
    try {
      s.type("/"); await s.sleep(150);
      await s.typeSlow("skill"); await s.sleep(200);
      s.type("\t"); await s.sleep(200);
      await s.typeSlow("vesicle-docs"); await s.sleep(200);
      s.type("\r");
      await s.waitFor("reply 1");
      const records = await s.readRecords();
      const header = records[0];
      const activationIndex = records.findIndex((r) => r.metadata?.kind === "skill-activation");
      console.log(`\n===== ${name} =====\ncalls=${s.calls()} identityError=${s.plain().includes(IDENTITY_ERROR)} header.role=${header?.role} harness=${header?.metadata?.harness ? "present" : "MISSING"} activationIndex=${activationIndex} mode=${String(records[activationIndex]?.metadata?.mode ?? "MISSING")}`);
      check(name, !s.plain().includes(IDENTITY_ERROR), "Harness identity guard fired");
      check(name, s.plain().includes("reply 1"), "provider reply never rendered");
      check(name, s.calls() === 1, `expected exactly 1 provider request, got ${s.calls()}`);
      check(name, header?.role === "system", "first durable record is not the system header");
      check(name, Boolean(header?.metadata?.harness), "session header missing the Harness identity");
      check(name, activationIndex > 0, "activation record missing or precedes the header");
      check(name, records[activationIndex]?.metadata?.mode === "invoke", "activation mode is not invoke");
    } finally {
      await s.teardown();
    }
  }

  // --- context-only and picker: provider deferred until a normal prompt ----
  const deferred: Array<{ name: string; drive: (s: PtySession) => Promise<void> }> = [
    {
      name: "context-only: /skill vesicle-docs --context-only",
      drive: async (s) => {
        s.type("/"); await s.sleep(150);
        await s.typeSlow("skill"); await s.sleep(200);
        s.type("\t"); await s.sleep(200);
        await s.typeSlow("vesicle-docs --context-only"); await s.sleep(200);
        s.type("\r");
      },
    },
    {
      name: "picker: bare /skill then select vesicle-docs",
      drive: async (s) => {
        s.type("/"); await s.sleep(150);
        await s.typeSlow("skill"); await s.sleep(300);
        s.type("\r"); await s.sleep(1500); // submit /skill -> open the picker
        s.type("\r"); // select the highlighted (only) skill
      },
    },
  ];

  for (const scenario of deferred) {
    const s = await startSession(target);
    try {
      await scenario.drive(s);
      // Wait for the durable activation so we know the command finished, then
      // give any (buggy) early provider call time to land before asserting zero.
      const activated = await s.waitForRecord(hasActivation);
      await s.sleep(1000);
      const callsBefore = s.calls();
      await s.submit(FOLLOW_UP_PROMPT);
      await s.waitFor("reply 1");
      const records = await s.readRecords();
      const header = records[0];
      const activationIndex = records.findIndex((r) => r.metadata?.kind === "skill-activation");
      const followUpUser = records.find((r) => r.role === "user" && r.metadata?.kind !== "skill-activation" && (r.content ?? "").includes(FOLLOW_UP_PROMPT));
      const assistant = records.find((r) => r.role === "assistant" && (r.content ?? "").includes("reply 1"));
      console.log(`\n===== ${scenario.name} =====\nactivated=${activated} callsBefore=${callsBefore} callsAfter=${s.calls()} identityError=${s.plain().includes(IDENTITY_ERROR)} header.role=${header?.role} harness=${header?.metadata?.harness ? "present" : "MISSING"} activationIndex=${activationIndex} mode=${String(records[activationIndex]?.metadata?.mode ?? "MISSING")} followUpUser=${Boolean(followUpUser)} assistant=${Boolean(assistant)}`);
      check(scenario.name, activated, "activation record never persisted");
      check(scenario.name, !s.plain().includes(IDENTITY_ERROR), "Harness identity guard fired");
      check(scenario.name, callsBefore === 0, `context-only made ${callsBefore} provider request(s) before any prompt`);
      check(scenario.name, s.calls() === 1, `expected exactly 1 provider request after the follow-up, got ${s.calls()}`);
      check(scenario.name, s.plain().includes("reply 1"), "follow-up reply never rendered");
      check(scenario.name, header?.role === "system", "first durable record is not the system header");
      check(scenario.name, Boolean(header?.metadata?.harness), "session header missing the Harness identity");
      check(scenario.name, activationIndex > 0, "activation record missing or precedes the header");
      check(scenario.name, records[activationIndex]?.metadata?.mode === "context-only", "activation mode is not context-only");
      check(scenario.name, Boolean(followUpUser), "follow-up user record not persisted");
      check(scenario.name, Boolean(assistant), "follow-up assistant record not persisted");
    } finally {
      await s.teardown();
    }
  }

  await target.cleanup();

  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAIL: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`\nPTY skill-first-input smoke passed at ${WIDTH}x${HEIGHT} (${target.label}).`);
  }
}

await main();
