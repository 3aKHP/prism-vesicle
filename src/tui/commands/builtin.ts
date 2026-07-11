// Built-in slash commands. Each branch of the former handleCommand if-else is
// now a Command object whose run() receives `args` for parsed arguments and
// `raw` for the original input, while TUI closures are reached through the
// CommandContext `ctx`.

import { engineIds } from "../../core/engine/profile";
import type { EngineId } from "../../core/engine/profile";
import { createManualEngineTransition } from "../../core/engine/transition";
import type { ProviderSelection } from "../../config/providers";
import type { Command } from "./types";
import {
  parseEngineId,
  parseReasoningDisplayMode,
  parseEffortTier,
  resolveArtifactTarget,
  resolveSessionTarget,
} from "./dispatch";
import {
  renderArtifactList,
  renderValidationNotice,
  renderEngineList,
} from "./render";

const HELP_TEXT = [
  "Commands:",
  "  /model [provider] [model]  switch provider/model (no args = pick)",
  "  /engine [id] [--summary [notes]] list or switch the Prism engine",
  "  /compact [notes]  summarize this session and replace old context",
  "  /context          show current context window usage",
  "  /effort <tier>    set thinking effort: off/low/medium/high/xhigh/max/auto",
  "  /reasoning <mode> show reasoning: hidden/collapsed/expanded (aliases: off/preview/on)",
  "  /artifact [n|path] list or preview generated artifacts",
  "  /validate <n|path> validate an artifact file",
  "  /rewind           restore code and/or conversation",
  "  /resume           list sessions",
  "  /resume <n|id>    resume a session",
  "  /new              start a fresh session",
  "  /help             show this help",
].join("\n");

export const builtinCommands: Command[] = [
  {
    name: "help",
    description: "Show available commands",
    async run(ctx, _args, raw) {
      ctx.setMessages((prev) => [
        ...prev,
        { role: "user", content: raw },
        { role: "system", content: HELP_TEXT },
      ]);
    },
  },

  {
    name: "engine",
    description: "List or switch the Prism engine for future turns",
    usage: "/engine [id]",
    async run(ctx, args, raw) {
      if (!args) {
        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: raw },
          { role: "system", content: renderEngineList(ctx.activeEngine()) },
        ]);
        return;
      }
      const parsed = parseEngineSwitchArgs(args);
      const engine = parsed?.engine;
      if (!engine) {
        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: raw },
          { role: "system", content: `Unknown engine "${args}". Available: ${engineIds.join(", ")}. Use /engine <id> [--summary [instructions]].` },
        ]);
        return;
      }
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
      const compact = parsed?.summary
        ? await ctx.compactSession(parsed.summaryInstructions)
        : undefined;
      const transition = createManualEngineTransition(ctx.activeEngine(), engine, compact
        ? {
            contextPolicy: "summary",
            contextSummary: compact.summary,
            handoffSummary: `Conversation compacted before switching engines. Summary covers ${compact.messagesSummarized} messages.`,
          }
        : {});
      ctx.setActiveEngine(engine);
      ctx.setStatus(`engine ${engine}`);
      ctx.recordActivity({ kind: "system", text: `engine switched to ${engine}` });
      await ctx.persistEngineSwitch(transition);
      ctx.setMessages((prev) => [
        ...prev,
        { role: "system", content: compact
          ? `Engine switched to ${engine} with summarized context. Future turns will use that profile.`
          : `Engine switched to ${engine}. Future turns will use that profile.` },
      ]);
    },
  },

  {
    name: "compact",
    description: "Summarize this session and replace old provider context",
    usage: "/compact [summary instructions]",
    async run(ctx, args, raw) {
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
      const result = await ctx.compactSession(args);
      ctx.setMessages((prev) => [
        ...prev,
        { role: "system", content: `Conversation compacted into a summary (${result.messagesSummarized} messages).` },
      ]);
    },
  },

  {
    name: "context",
    description: "Show current context window usage",
    usage: "/context",
    async run(ctx, _args, raw) {
      ctx.setMessages((prev) => [
        ...prev,
        { role: "user", content: raw },
        { role: "system", content: renderContextStatus(ctx) },
      ]);
    },
  },

  {
    name: "model",
    description: "Switch provider/model (no args opens a picker)",
    usage: "/model [provider] [model]",
    async run(ctx, args, raw) {
      const parts = args.split(/\s+/).filter(Boolean);
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
      if (parts.length === 0) {
        // No args: open the interactive provider→model picker.
        await ctx.openModelPicker();
        return;
      }
      const [providerId, ...modelParts] = parts;
      const model = modelParts.join(" ");
      let requested: Partial<ProviderSelection>;
      if (model) {
        // /model <provider> <model> → exact selection.
        requested = { provider: providerId, model };
      } else {
        const registry = await ctx.ensureProviderRegistry();
        // One argument is a provider shortcut when it names a provider;
        // otherwise preserve the established /model <model> active-provider
        // form so the consolidated command does not break existing usage.
        requested = registry.providers.some((provider) => provider.id === providerId)
          ? { provider: providerId }
          : { provider: ctx.activeProvider(), model: providerId };
      }
      const selection = await ctx.applyProviderSelection(requested);
      await ctx.persistProviderSwitch(selection);
      ctx.setMessages((prev) => [...prev, { role: "system", content: `Using ${selection.provider}/${selection.model}.` }]);
    },
  },

  {
    name: "effort",
    description: "Set provider thinking effort",
    usage: "/effort off|low|medium|high|xhigh|max|auto",
    async run(ctx, args, raw) {
      if (!args) {
        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: raw },
          { role: "system", content: `Thinking effort: ${ctx.thinkingTier() ?? "provider default"}. Use /effort off|low|medium|high|xhigh|max|auto.` },
        ]);
        return;
      }
      const tier = parseEffortTier(args);
      if (!tier) {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: "Usage: /effort off|low|medium|high|xhigh|max|auto" }]);
        return;
      }
      if (tier === "auto") {
        ctx.setThinkingTier(undefined);
        ctx.setStatus("effort provider default");
        ctx.recordActivity({ kind: "provider", text: "thinking effort provider default" });
        await ctx.persistThinkingSwitch(undefined);
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: "Thinking effort reset to provider default." }]);
        return;
      }
      ctx.setThinkingTier(tier);
      ctx.setStatus(`effort ${tier}`);
      ctx.recordActivity({ kind: "provider", text: `thinking effort ${tier}` });
      await ctx.persistThinkingSwitch(tier);
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: `Thinking effort set to ${tier}.` }]);
    },
  },

  {
    name: "reasoning",
    description: "Set reasoning display mode",
    usage: "/reasoning hidden|collapsed|expanded",
    async run(ctx, args, raw) {
      if (!args) {
        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: raw },
          { role: "system", content: `Reasoning display: ${ctx.reasoningDisplayMode()}. Use /reasoning hidden|collapsed|expanded (aliases: off|preview|on).` },
        ]);
        return;
      }
      const mode = parseReasoningDisplayMode(args);
      if (!mode) {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: "Usage: /reasoning hidden|collapsed|expanded" }]);
        return;
      }
      ctx.setReasoningDisplayMode(mode);
      ctx.setStatus(`reasoning ${mode}`);
      ctx.recordActivity({ kind: "provider", text: `reasoning display ${mode}` });
      await ctx.persistReasoningSwitch(mode);
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: `Reasoning display set to ${mode}.` }]);
    },
  },

  {
    name: "artifact",
    description: "List artifacts or preview one in the message stream",
    usage: "/artifact [n|path]",
    async run(ctx, args, raw) {
      const entries = args ? (ctx.artifacts().length > 0 ? ctx.artifacts() : await ctx.refreshArtifacts()) : await ctx.refreshArtifacts();
      if (!args) {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: renderArtifactList(entries) }]);
        return;
      }
      const artifact = resolveArtifactTarget(entries, args);
      if (!artifact) {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: `No artifact matches "${args}". Use /artifact to list.` }]);
        return;
      }
      const selected = await ctx.loadArtifactPreview(artifact);
      ctx.setSelectedArtifact(selected);
      ctx.setMessages((prev) => [
        ...prev,
        { role: "user", content: raw },
        {
          role: "system",
          kind: "artifact",
          content: selected.preview,
          artifactPath: selected.path,
          artifactTruncated: selected.truncated,
        },
      ]);
    },
  },

  {
    name: "validate",
    description: "Validate an artifact file",
    usage: "/validate <n|path>",
    async run(ctx, args, raw) {
      const entries = ctx.artifacts().length > 0 ? ctx.artifacts() : await ctx.refreshArtifacts();
      const artifact = resolveArtifactTarget(entries, args);
      if (!artifact) {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: `No artifact matches "${args || "(empty)"}". Use /artifact to list.` }]);
        return;
      }
      const selected = await ctx.loadArtifactPreview(artifact, { validate: true });
      ctx.setSelectedArtifact(selected);
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: renderValidationNotice(selected.validation) }]);
    },
  },

  {
    name: "rewind",
    aliases: ["checkpoint"],
    description: "Restore code and/or conversation to an earlier point",
    async run(ctx) {
      await ctx.openRewindPicker();
    },
  },

  {
    name: "new",
    description: "Start a fresh session",
    async run(ctx, _args, raw) {
      ctx.resetRewindState();
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
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
      ctx.setMessages((prev) => [...prev, { role: "system", content: "Started a fresh session. Type a prompt to begin." }]);
    },
  },

  {
    name: "resume",
    description: "Resume a saved session",
    usage: "/resume [n|id]",
    async run(ctx, args, raw) {
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

function renderContextStatus(ctx: Parameters<Command["run"]>[0]): string {
  const limits = ctx.activeModelLimits();
  const usage = ctx.lastTurnUsage();
  const contextWindow = limits?.contextWindow;
  const contextInput = usage?.contextInputTokens;
  const lines = [
    "Context",
    `${ctx.activeProvider()}/${ctx.activeModel()}`,
  ];

  if (!contextWindow) {
    lines.push("Context window: not configured");
    lines.push("Add limits.contextWindow to this model in providers.yaml to enable footer percentages.");
  } else if (typeof contextInput === "number" && contextInput > 0) {
    lines.push(`Used: ${formatTokenCount(contextInput)} / ${formatTokenCount(contextWindow)} (${formatPercent(contextInput, contextWindow)})`);
    const reserve = limits.autoCompact?.reserveOutputTokens ?? limits.maxOutputTokens;
    if (reserve && reserve < contextWindow) {
      lines.push(`Effective budget: ${formatTokenCount(contextWindow - reserve)} after reserving ${formatTokenCount(reserve)} output`);
    }
  } else {
    lines.push(`Context window: ${formatTokenCount(contextWindow)}`);
    lines.push("Used: no provider usage yet");
  }

  const autoCompact = limits?.autoCompact;
  if (contextWindow && autoCompact) {
    const enabled = autoCompact.enabled === false ? "disabled" : "enabled";
    const threshold = autoCompact.threshold;
    lines.push(threshold
      ? `Auto compact: ${enabled} at ${Math.round(threshold * 100)}% (~${formatTokenCount(contextWindow * threshold)})`
      : `Auto compact: ${enabled}`);
  }
  if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cachedInputTokens > 0)) {
    lines.push(`Turn: ↑${formatTokenCount(usage.inputTokens)} ↓${formatTokenCount(usage.outputTokens)} ↻ ${formatTokenCount(usage.cachedInputTokens)}`);
  }
  const session = ctx.sessionUsage();
  if (session.inputTokens > 0 || session.outputTokens > 0 || session.cachedInputTokens > 0) {
    lines.push(`Session: ↑${formatTokenCount(session.inputTokens)} ↓${formatTokenCount(session.outputTokens)} ↻ ${formatTokenCount(session.cachedInputTokens)}`);
  }
  lines.push(`Source: ${usage ? "provider usage, de-duplicated by logical turn" : "model config only"}`);
  return lines.join("\n");
}

function formatTokenCount(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatPercent(used: number, total: number): string {
  if (total <= 0) return "n/a";
  const percent = (used / total) * 100;
  return percent < 1 && percent > 0 ? "<1%" : `${Math.round(percent)}%`;
}

function parseEngineSwitchArgs(args: string): { engine: EngineId; summary: boolean; summaryInstructions?: string } | undefined {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  const engine = parseEngineId(parts[0]);
  if (!engine) return undefined;
  const summaryIndex = parts.indexOf("--summary");
  if (summaryIndex < 0) return { engine, summary: false };
  return {
    engine,
    summary: true,
    ...(parts.slice(summaryIndex + 1).join(" ").trim()
      ? { summaryInstructions: parts.slice(summaryIndex + 1).join(" ").trim() }
      : {}),
  };
}
