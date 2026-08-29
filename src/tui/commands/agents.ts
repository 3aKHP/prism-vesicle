// /agents, /stage, /btw — SubAgent control, Stage narrative startup, and
// temporary side questions. Grouped because they share no state with the other
// families and all reach host-owned controllers through the same narrow port.

import { afterAgentLoop, immediate } from "./dispatch";
import { agentsCommandCompletion, splitTokens, stageCommandCompletion } from "./argument-completion";
import type { Command, AgentsCommandContext } from "./types";

export function createAgentsCommands(ctx: AgentsCommandContext): Command[] {
  return [
    {
      name: "stage",
      busyBehavior: afterAgentLoop,
      description: "Start a new Stage narrative session from two cards",
      usage: "/stage <character-card-path> <scenario-card-path>",
      completion: stageCommandCompletion,
      async run(args, raw) {
        const parts = splitTokens(args).values;
        if (parts.length !== 2) {
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: "Usage: /stage <character-card-path> <scenario-card-path>. Paths are project-relative and must be under an approved readable root." }]);
          return;
        }
        if (!ctx.startStage) throw new Error("Stage startup is unavailable in this command context.");
        await ctx.startStage(parts[0]!, parts[1]!, raw);
      },
    },

    {
      name: "btw",
      busyBehavior: immediate,
      description: "Ask a temporary question about the current conversation",
      usage: "/btw <question>",
      completion: null,
      async run(args) {
        await ctx.openSideQuestion(args);
      },
    },

    {
      name: "agents",
      busyBehavior: (args) => args.trim() === "retry" ? afterAgentLoop : immediate,
      description: "List Agent Profiles and current SubAgents",
      usage: "/agents [handle|stop <handle>|retry]",
      completion: agentsCommandCompletion,
      async run(args, raw) {
        const result = await ctx.agentCommand(args);
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: result }]);
      },
    },
  ];
}
