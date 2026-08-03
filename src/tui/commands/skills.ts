// /skill — skill picker and activation. The activation use case itself lives in
// src/tui/skills/session-activation.ts (T1); this command only forwards the
// picker/activate ports the App already wires.

import { afterAgentLoop, immediate } from "./dispatch";
import { skillCommandCompletion } from "./argument-completion";
import type { Command, SkillCommandContext } from "./types";

export function createSkillCommands(ctx: SkillCommandContext): Command[] {
  return [
    {
      name: "skill",
      busyBehavior: (args) => {
        const trimmed = args.trim();
        if (!trimmed || trimmed.endsWith("--context-only")) return immediate;
        return afterAgentLoop;
      },
      description: "List, activate, or invoke a Skill",
      usage: "/skill [name [task|--context-only]]",
      completion: skillCommandCompletion,
      async run(args, raw) {
        const trimmed = args.trim();
        if (!trimmed) {
          await ctx.openSkillPicker();
          return;
        }
        const contextOnly = trimmed.endsWith("--context-only");
        const withoutFlag = contextOnly ? trimmed.slice(0, -"--context-only".length).trim() : trimmed;
        const spaceIndex = withoutFlag.indexOf(" ");
        const name = spaceIndex === -1 ? withoutFlag : withoutFlag.slice(0, spaceIndex);
        const taskText = spaceIndex === -1 ? undefined : withoutFlag.slice(spaceIndex + 1).trim() || undefined;
        if (!name) {
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: "Usage: /skill [name [task|--context-only]]" }]);
          return;
        }
        await ctx.activateSkill(name, {
          mode: contextOnly ? "context-only" : "invoke",
          ...(taskText ? { taskText } : {}),
        });
      },
    },
  ];
}
