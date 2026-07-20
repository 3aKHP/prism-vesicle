import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderRegistry } from "../src/config/providers";
import type { ArtifactEntry } from "../src/core/artifacts/workbench";
import { listStageCardPaths } from "../src/core/stage/bootstrap";
import { resolveCommandArgumentCompletion } from "../src/tui/commands/argument-completion";
import { builtinCommands } from "../src/tui/commands/builtin";
import { argumentMenuLabelBudget } from "../src/tui/widgets/ArgumentMenu";
import type { CommandArgumentCompletion, CommandCompletionContext } from "../src/tui/commands/types";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const registry: ProviderRegistry = {
  source: "file",
  default: { provider: "alpha", model: "alpha-chat" },
  providers: [
    { id: "alpha", protocol: "openai-chat-compatible", baseUrl: "https://alpha.example/v1", apiKeyEnv: "ALPHA_KEY", models: [{ id: "alpha-chat" }] },
    { id: "beta", protocol: "openai-chat-compatible", baseUrl: "https://beta.example/v1", apiKeyEnv: "BETA_KEY", models: [{ id: "beta-reasoner" }] },
  ],
};

const artifacts: ArtifactEntry[] = [
  { path: "workspace/cards/mira.md", updatedAt: "2026-07-20T00:00:00.000Z" },
  { path: "reports/audit.md", updatedAt: "2026-07-19T00:00:00.000Z" },
];

function context(overrides: Partial<CommandCompletionContext> = {}): CommandCompletionContext {
  return {
    rootDir: process.cwd(),
    providerRegistry: () => registry,
    activeProvider: () => "beta",
    refreshArtifacts: async () => artifacts,
    listSessions: async () => [{
      sessionId: "session-current-123",
      startedAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      recordCount: 2,
      preview: "Resume this work",
    }],
    agentOptions: () => [{ id: "explore-1", label: "explore-1", detail: "running · inspect files" }],
    ...overrides,
  };
}

function resolve(draft: string, overrides: Partial<CommandCompletionContext> = {}): CommandArgumentCompletion {
  const completion = resolveCommandArgumentCompletion(draft, builtinCommands, context(overrides));
  if (!completion) throw new Error(`Expected completion for ${draft}`);
  return completion;
}

async function items(completion: CommandArgumentCompletion) {
  return Array.isArray(completion.items) ? completion.items : await completion.items();
}

describe("command-owned argument completion", () => {
  test("registers completion contracts beside every command with audited arguments", () => {
    for (const name of ["model", "engine", "stage", "quality", "artifact", "validate", "resume", "agents", "effort", "reasoning", "permissions"]) {
      expect(builtinCommands.find((command) => command.name === name)?.completion).toBeDefined();
    }
  });

  test("preserves provider-first /model completion and adds active-provider shorthand", async () => {
    const initial = resolve("/model ");
    expect((await items(initial)).map((item) => item.id)).toEqual(["alpha", "beta"]);
    expect(initial.complete((await items(initial))[0]!)).toBe("/model alpha ");

    const explicit = resolve("/model alpha ");
    expect((await items(explicit)).map((item) => item.id)).toEqual(["alpha-chat"]);
    expect(explicit.complete((await items(explicit))[0]!)).toBe("/model alpha alpha-chat");

    const shorthand = resolve("/model beta-r");
    const model = (await items(shorthand)).find((item) => item.id === "beta-reasoner");
    expect(model).toBeDefined();
    expect(shorthand.complete(model!)).toBe("/model beta-reasoner");
  });

  test("walks the quality grammar through fixed, provider, and model stages", async () => {
    const mode = resolve("/quality ");
    expect((await items(mode)).map((item) => item.id)).toEqual(["status", "off", "observe", "rewrite", "confirm"]);
    expect(mode.complete((await items(mode))[2]!)).toBe("/quality observe ");

    const provider = resolve("/quality observe ");
    expect((await items(provider)).map((item) => item.id)).toEqual(["alpha", "beta"]);
    expect(provider.complete((await items(provider))[0]!)).toBe("/quality observe alpha ");

    const model = resolve("/quality observe alpha ");
    expect((await items(model)).map((item) => item.id)).toEqual(["alpha-chat"]);
    expect(model.complete((await items(model))[0]!)).toBe("/quality observe alpha alpha-chat ");

    const confirmed = resolve("/quality confirm ");
    expect((await items(confirmed)).map((item) => item.id)).toEqual(["rewrite"]);
    expect(confirmed.complete((await items(confirmed))[0]!)).toBe("/quality confirm rewrite ");
  });

  test("completes artifact, validation, and resumable-session targets from refreshed stores", async () => {
    const artifact = resolve("/artifact ");
    expect((await items(artifact)).map((item) => item.id)).toEqual(artifacts.map((entry) => entry.path));
    expect(artifact.complete((await items(artifact))[0]!)).toBe("/artifact workspace/cards/mira.md");

    const validate = resolve("/validate rep");
    expect(validate.complete((await items(validate))[1]!)).toBe("/validate reports/audit.md");

    const resume = resolve("/resume ");
    expect((await items(resume))[0]?.id).toBe("session-current-123");
    expect(resume.complete((await items(resume))[0]!)).toBe("/resume session-current-123");
  });

  test("offers the optional engine summary token only after an engine id", async () => {
    const engine = resolve("/engine run");
    expect((await items(engine)).map((item) => item.id)).toContain("runtime");
    expect(engine.complete((await items(engine)).find((item) => item.id === "runtime")!)).toBe("/engine runtime");

    const summary = resolve("/engine runtime ");
    expect((await items(summary)).map((item) => item.id)).toEqual(["--summary"]);
    expect(summary.complete((await items(summary))[0]!)).toBe("/engine runtime --summary ");
  });
});

describe("Stage completion paths", () => {
  test("lists only guarded project-relative files under Stage-readable roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-stage-completion-"));
    roots.push(root);
    await mkdir(join(root, "workspace", "cards"), { recursive: true });
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "workspace", "cards", "mira card.md"), "card", "utf8");
    await writeFile(join(root, "assets", "hidden.md"), "asset", "utf8");
    await symlink(join(root, "assets", "hidden.md"), join(root, "workspace", "linked.md"));

    expect(await listStageCardPaths(root)).toEqual(["workspace/cards/mira card.md"]);

    const first = resolve("/stage ", { rootDir: root });
    const candidate = (await items(first))[0]!;
    expect(candidate.id).toBe("workspace/cards/mira card.md");
    expect(candidate.detail).toBeUndefined();
    expect(first.complete(candidate)).toBe('/stage "workspace/cards/mira card.md" ');

    const second = resolve('/stage "workspace/cards/mira card.md" ', { rootDir: root });
    expect(second.complete((await items(second))[0]!)).toBe('/stage "workspace/cards/mira card.md" "workspace/cards/mira card.md"');
  });

  test("lets Stage paths use the whole candidate row when no item detail is present", () => {
    expect(argumentMenuLabelBudget(80, false)).toBe(79);
    expect(argumentMenuLabelBudget(80, true)).toBe(22);
  });
});

describe("completion controller dynamic sources", () => {
  test("keeps stale loads and shared keyboard actions guarded in the controller", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "command-completion-controller.ts"), "utf8");

    expect(source).toContain("let current = true");
    expect(source).toContain("if (!current) return");
    expect(source).toContain("loadedSourceKey() === draft.sourceKey");
    expect(source).toContain('if (name === "tab")');
    expect(source).toContain('if (name === "escape")');
    expect(source).toContain('options.setStatus("request in flight; draft kept")');
  });
});
