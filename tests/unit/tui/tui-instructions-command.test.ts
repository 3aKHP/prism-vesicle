import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinCommands } from "../../../src/tui/commands/builtin";
import type { CommandContext } from "../../../src/tui/commands/types";
import type { Message } from "../../../src/tui/types";

const originalCwd = process.cwd();
const originalConfigDir = process.env.VESICLE_CONFIG_DIR;
const originalProvidersFile = process.env.VESICLE_PROVIDERS_FILE;
const directories: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalConfigDir === undefined) delete process.env.VESICLE_CONFIG_DIR;
  else process.env.VESICLE_CONFIG_DIR = originalConfigDir;
  if (originalProvidersFile === undefined) delete process.env.VESICLE_PROVIDERS_FILE;
  else process.env.VESICLE_PROVIDERS_FILE = originalProvidersFile;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("/instructions command", () => {
  test("lists active project and user instruction files for the active engine", async () => {
    const project = await mkdtemp(join(tmpdir(), "vesicle-instr-cmd-"));
    const config = await mkdtemp(join(tmpdir(), "vesicle-instr-cfg-"));
    directories.push(project, config);
    await writeFile(join(project, "VESICLE.md"), "project rule", "utf8");
    await writeFile(join(config, "VESICLE.md"), "user rule", "utf8");
    process.env.VESICLE_CONFIG_DIR = config;
    delete process.env.VESICLE_PROVIDERS_FILE;
    process.chdir(project);

    const command = builtinCommands.find((entry) => entry.name === "instructions");
    if (!command) throw new Error("Missing /instructions command.");
    let messages: Message[] = [];
    const ctx = {
      activeEngine: () => "etl",
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/instructions");
    const notice = messages.at(-1)?.content ?? "";
    expect(notice).toContain('engine "etl"');
    expect(notice).toContain("VESICLE.md [project]");
    expect(notice).toContain("VESICLE.md [user]");
    expect(notice).toContain("Combined budget:");
    expect(notice).toContain("cannot add tools");
  });

  test("reports no active files and the locations when none exist", async () => {
    const project = await mkdtemp(join(tmpdir(), "vesicle-instr-empty-"));
    const config = await mkdtemp(join(tmpdir(), "vesicle-instr-empty-cfg-"));
    directories.push(project, config);
    process.env.VESICLE_CONFIG_DIR = config;
    delete process.env.VESICLE_PROVIDERS_FILE;
    process.chdir(project);

    const command = builtinCommands.find((entry) => entry.name === "instructions")!;
    let messages: Message[] = [];
    const ctx = {
      activeEngine: () => "runtime",
      setMessages(updater: (previous: Message[]) => Message[]) {
        messages = updater(messages);
      },
    } as unknown as CommandContext;

    await command.run(ctx, "", "/instructions");
    const notice = messages.at(-1)?.content ?? "";
    expect(notice).toContain("No instruction files are active");
    expect(notice).toContain("VESICLE.md");
  });
});
