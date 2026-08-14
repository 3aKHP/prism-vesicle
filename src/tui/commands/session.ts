// /new, /resume, /rewind, /compact, /init — session lifecycle: fresh session,
// resume, rewind picker, mid-session compaction, and project initialisation.

import { afterAgentLoop, parseInitCommandArgs, resolveSessionTarget } from "./dispatch";
import { resumeCommandCompletion } from "./argument-completion";
import type { Command, SessionCommandContext } from "./types";

export function createSessionCommands(ctx: SessionCommandContext): Command[] {
  return [
    {
      name: "compact",
      busyBehavior: afterAgentLoop,
      description: "Summarize this session and replace old provider context",
      usage: "/compact [summary instructions]",
      async run(args, raw) {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
        const result = await ctx.compactSession(args);
        ctx.setMessages((prev) => [
          ...prev,
          { role: "system", content: `Conversation compacted into a summary (${result.messagesSummarized} messages).` },
        ]);
      },
    },

    {
      name: "init",
      busyBehavior: afterAgentLoop,
      description: "Scan the project and generate a VESICLE.md of persistent instructions",
      usage: "/init [--force] [notes]",
      async run(args, raw) {
        const parsed = parseInitCommandArgs(args);
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
        if ("error" in parsed) {
          ctx.setMessages((prev) => [...prev, { role: "system", content: parsed.error }]);
          return;
        }
        await ctx.initProject(parsed);
      },
    },

    {
      name: "rewind",
      busyBehavior: afterAgentLoop,
      aliases: ["checkpoint"],
      description: "Restore code and/or conversation to an earlier point",
      async run() {
        await ctx.openRewindPicker();
      },
    },

    {
      name: "branch",
      busyBehavior: afterAgentLoop,
      description: "Browse and switch candidate branches at any depth (Ctrl+B)",
      async run() {
        await ctx.openBranchPicker();
      },
    },

    {
      name: "new",
      busyBehavior: afterAgentLoop,
      description: "Start a fresh session",
      async run(_args, raw) {
        ctx.resetRewindState();
        ctx.theme.clearOverride();
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
        const resetStage = ctx.activeEngine() === "stage";
        if (resetStage) ctx.setActiveEngine("etl");
        ctx.setSessionId(undefined);
        ctx.setSessionPath("no session yet");
        ctx.setConversation([]);
        ctx.setOutput("");
        ctx.setLastTurnUsage(undefined);
        ctx.setSessionUsage({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, contextInputTokens: 0 });
        ctx.setPendingGate(null);
        ctx.setPendingEngineSwitch(null);
        ctx.setPendingUserQuestion(null);
        ctx.setStatus("fresh session");
        ctx.setMessages((prev) => [...prev, {
          role: "system",
          content: resetStage
            ? "Started a fresh session with ETL. Start another Stage narrative with /stage <character-card-path> <scenario-card-path>."
            : "Started a fresh session. Type a prompt to begin.",
        }]);
      },
    },

    {
      name: "resume",
      busyBehavior: afterAgentLoop,
      description: "Resume a saved session",
      usage: "/resume [n|id]",
      completion: resumeCommandCompletion,
      async run(args, raw) {
        const sessions = await ctx.listSessions();
        ctx.setResumableSessions(sessions);
        if (sessions.length === 0) {
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: "No existing sessions found." }]);
          return;
        }
        if (!args) {
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
          ctx.setSessionPicker({ sessions, selected: 0 });
          ctx.setStatus("choose a session to resume");
          return;
        }
        const target = resolveSessionTarget(sessions, args);
        if (!target) {
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: `No session matches "${args}".` }]);
          return;
        }
        await ctx.resumeSession(target, raw);
      },
    },
  ];
}
