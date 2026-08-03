// activate_skill executor: injects the exact SKILL.md body as a tagged tool
// result, records the activation, and deduplicates identical content. Does not
// import process — activation is pure context injection.

import type { ToolCall, ToolResult } from "../../tools/types";
import type { SkillToolEvent } from "../types";
import { isDuplicateActivation, recordActivation } from "../activation-state";
import { requireRuntime, fail, formatSkillActivationBlock } from "./activated-skill";
import type { SkillToolRuntimeOptions, ValidSkill } from "./activated-skill";
import { parseArgs } from "./arguments";

export async function executeActivateSkillTool(call: ToolCall, options: SkillToolRuntimeOptions): Promise<ToolResult> {
  const unavailable = requireRuntime(call, options);
  if (unavailable) return unavailable;
  const args = parseArgs(call, ["name"]);
  if ("error" in args) return fail(call, (args as { error: string }).error);
  const name = args.name as string;

  const skill = options.catalog!.byName.get(name);
  if (!skill || !skill.parsed.ok) {
    const available = [...options.catalog!.byName.keys()].join(", ") || "(none)";
    return fail(call, `Unknown skill "${name}". Available skills: ${available}.`);
  }

  const contentHash = skill.parsed.bodySha256;
  const event: SkillToolEvent = {
    kind: "skill_activation",
    name: skill.name,
    scope: skill.scope,
    contentHash,
    alreadyActive: isDuplicateActivation(options.sessionId!, skill.name, contentHash),
    resources: skill.parsed.resources,
    diagnostics: skill.parsed.diagnostics,
  };

  if (event.kind === "skill_activation" && event.alreadyActive) {
    return {
      callId: call.id,
      name: call.name,
      ok: true,
      content:
        `[skill_activation name="${skill.name}" scope="${skill.scope}" hash="${contentHash}" status="already-active"]\n` +
        `Skill "${skill.name}" is already active with the same content; its instructions are not repeated.\n` +
        `[/skill_activation]`,
      skillEvent: event,
    };
  }

  recordActivation(options.sessionId!, skill.name, contentHash);
  return { callId: call.id, name: call.name, ok: true, content: formatSkillActivationBlock(skill as ValidSkill, "activated"), skillEvent: event };
}
