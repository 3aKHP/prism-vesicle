import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../src/core/tools/types";
import { executeActivateSkillTool } from "../../../src/core/skills";
import { clearSessionActivations } from "../../../src/core/skills";
import { catalogFor, loadWritten, makeScratch, writeSkill } from "./helpers";

let scratch: string;
let sessionId: string;

beforeEach(async () => {
  scratch = await makeScratch();
  sessionId = randomUUID();
});

afterEach(async () => {
  clearSessionActivations(sessionId);
  await rm(scratch, { recursive: true, force: true });
});

function call(name: string, args: unknown): ToolCall {
  return { id: `call-${randomUUID()}`, name, arguments: JSON.stringify(args) };
}

describe("activate_skill executor", () => {
  test("activates a catalog skill: exact body, resources, event, no host paths", async () => {
    const body = "# Alpha\n\nDo the alpha procedure exactly.";
    const root = await writeSkill(scratch, "alpha", {
      body,
      files: { "references/note.md": "note text", "scripts/tool.sh": "#!/bin/sh\nexit 0\n" },
    });
    const skill = await loadWritten(root);
    const catalog = catalogFor(skill);

    const result = await executeActivateSkillTool(call("activate_skill", { name: "alpha" }), { catalog, sessionId });

    expect(result.ok).toBe(true);
    expect(result.content).toContain(`[skill_activation name="alpha" scope="user" hash="${skill.parsed.ok ? skill.parsed.bodySha256 : ""}" status="activated"]`);
    expect(result.content).toContain(body);
    expect(result.content).toContain("[/skill_activation]");
    // The frontmatter is stripped from the injected body.
    expect(result.content).not.toContain("description: alpha description");
    // The full package contents are disclosed with kinds and sizes.
    expect(result.content).toContain("references/note.md (reference, 9 bytes)");
    expect(result.content).toContain("scripts/tool.sh (script,");
    // Subordination and script-routing reminder closes the activation.
    expect(result.content).toContain("subordinate to Vesicle host rules");
    expect(result.content).toContain("run_skill_script");

    expect(result.skillEvent).toMatchObject({
      kind: "skill_activation",
      name: "alpha",
      scope: "user",
      contentHash: skill.parsed.ok ? skill.parsed.bodySha256 : "",
      alreadyActive: false,
    });
    if (result.skillEvent?.kind === "skill_activation") {
      expect(result.skillEvent.resources.map((resource) => resource.path)).toEqual(["references/note.md", "scripts/tool.sh"]);
    }
    // No absolute host path leaks into model-visible content or the event.
    expect(result.content).not.toContain(scratch);
    expect(JSON.stringify(result.skillEvent)).not.toContain(scratch);
  });

  test("rejects a stale name with the valid names listed", async () => {
    const catalog = catalogFor(await loadWritten(await writeSkill(scratch, "alpha", {})));
    const result = await executeActivateSkillTool(call("activate_skill", { name: "ghost" }), { catalog, sessionId });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('Unknown skill "ghost"');
    expect(result.content).toContain("alpha");
    expect(result.skillEvent).toBeUndefined();
  });

  test("deduplicates reactivation at the same content hash", async () => {
    const body = "UNIQUE-BODY-MARKER alpha procedure.";
    const catalog = catalogFor(await loadWritten(await writeSkill(scratch, "alpha", { body })));

    const first = await executeActivateSkillTool(call("activate_skill", { name: "alpha" }), { catalog, sessionId });
    const second = await executeActivateSkillTool(call("activate_skill", { name: "alpha" }), { catalog, sessionId });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.content).toContain('status="already-active"');
    expect(second.content).not.toContain(body);
    expect(second.skillEvent).toMatchObject({ kind: "skill_activation", alreadyActive: true });
  });

  test("fails closed when the host has not wired a catalog", async () => {
    const result = await executeActivateSkillTool(call("activate_skill", { name: "alpha" }), {});
    expect(result.ok).toBe(false);
    expect(result.content).toContain("no Skill catalog is active");
  });
});
