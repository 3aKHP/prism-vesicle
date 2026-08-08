import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSkillsCommand } from "../../../src/cli/commands/skills";

describe("vesicle skills list resilience", () => {
  // `runList` reads the active index via `process.env` and has no env parameter,
  // so the corrupted store is pointed at through VESICLE_CONFIG_DIR for this
  // command-level test. A corrupt index must not abort the listing of the
  // harness/user scopes (the same guard `vesicle doctor` already uses).
  test("survives a corrupted Skill Store index and still prints the listing header", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "vesicle-skills-list-"));
    const configDir = join(scratch, "config");
    await mkdir(join(configDir, "skill-store"), { recursive: true });
    await writeFile(join(configDir, "skill-store", "index.json"), "{ this is not valid json", "utf8");

    const savedConfigDir = process.env.VESICLE_CONFIG_DIR;
    process.env.VESICLE_CONFIG_DIR = configDir;
    const savedLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.map((value) => String(value)).join(" "));

    let threw = false;
    try {
      await runSkillsCommand(["list"]);
    } catch {
      threw = true;
    } finally {
      console.log = savedLog;
      if (savedConfigDir === undefined) delete process.env.VESICLE_CONFIG_DIR;
      else process.env.VESICLE_CONFIG_DIR = savedConfigDir;
      await rm(scratch, { recursive: true, force: true });
    }

    expect(threw).toBe(false);
    expect(logs.join("\n")).toContain("Prism Vesicle Skills");
    expect(logs.join("\n")).toContain("installed unavailable");
  });
});
