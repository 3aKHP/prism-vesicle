import { afterEach, describe, expect, test } from "bun:test";
import { runSkillsCommand } from "../../../src/cli/skills";

describe("vesicle skills copy-template destinations", () => {
  const savedLog = console.error;
  const savedExitCode = process.exitCode;
  const errors: string[] = [];

  afterEach(() => {
    console.error = savedLog;
    process.exitCode = savedExitCode;
    errors.length = 0;
  });

  test("refuses the scratch tmp/ root and keeps approved content roots accepted", async () => {
    console.error = (...args: unknown[]) => errors.push(args.map((value) => String(value)).join(" "));

    await runSkillsCommand(["copy-template", "no-such-skill", "SKILL.md", "tmp/example.md"]);
    expect(errors.join("\n")).toContain("Destination must be under an approved content root");
    expect(errors.join("\n")).toContain("Got: \"tmp\".");
    errors.length = 0;

    // The destination check passes for workspace; the command then fails on
    // the missing skill instead, proving the destination was accepted.
    await runSkillsCommand(["copy-template", "no-such-skill", "SKILL.md", "workspace/example.md"]);
    const messages = errors.join("\n");
    expect(messages).not.toContain("approved content root");
    expect(messages).toContain("No skill named \"no-such-skill\"");
  });
});
