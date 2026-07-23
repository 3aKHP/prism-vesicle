// Built-in slash commands. Each branch of the former handleCommand if-else is
// now a Command object whose run() receives `args` for parsed arguments and
// `raw` for the original input, while TUI closures are reached through the
// CommandContext `ctx`.

import { engineIds } from "../../core/engine/profile";
import type { EngineId } from "../../core/engine/profile";
import { createManualEngineTransition } from "../../core/engine/transition";
import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import {
  loadExperimentalQualitySettings,
  writeExperimentalQualitySettings,
} from "../../config/quality";
import type { Command } from "./types";
import { permissionModes, type PermissionMode } from "../../core/permissions";
import {
  parseEngineId,
  parseReasoningDisplayMode,
  parseEffortTier,
  resolveArtifactTarget,
  resolveSessionTarget,
} from "./dispatch";
import {
  agentsCommandCompletion,
  artifactCommandCompletion,
  engineCommandCompletion,
  fixedCommandCompletion,
  modelCommandCompletion,
  qualityCommandCompletion,
  resumeCommandCompletion,
  splitTokens,
  stageCommandCompletion,
} from "./argument-completion";
import {
  renderArtifactList,
  renderValidationNotice,
  renderEngineList,
} from "./render";
import { INSTRUCTION_COMBINED_BUDGET_BYTES, resolveEffectiveSelection } from "../../core/instructions";
import type { EffectiveInstructionSelection } from "../../core/instructions";

const HELP_TEXT = [
  "Commands:",
  "  /model [provider] [model]  switch provider/model (no args = pick)",
  "  /engine [id] [--summary [notes]] list or switch the Prism engine",
  "  /stage <character-card-path> <scenario-card-path> start a new Stage narrative session",
  "  /compact [notes]  summarize this session and replace old context",
  "  /init [notes]     scan the project and generate a VESICLE.md of persistent instructions",
  "  /context          show current context window usage",
  "  /instructions     show active Persistent Instructions for this engine",
  "  /agents [handle|stop <handle>|retry] list, inspect, interrupt, or retry SubAgent delivery",
  "  /effort <tier>    set thinking effort: off/low/medium/high/xhigh/max/auto",
  "  /reasoning <mode> show reasoning: hidden/collapsed/expanded (aliases: off/preview/on)",
  "  /permissions [mode] show or set MANUAL/INERTIA/MOMENTUM/YOLO tool approval mode",
  "  /quality [off|observe|rewrite] show or configure the experimental Semantic Judge",
  "  /artifact [n|path] list or preview generated artifacts",
  "  /validate <n|path> validate an artifact file",
  "  /rewind           restore code and/or conversation",
  "  /btw <question>   ask a temporary side question without interrupting the turn",
  "  /resume           list sessions",
  "  /resume <n|id>    resume a session",
  "  /new              start a fresh session",
  "  /help             show this help",
].join("\n");

const immediate = { kind: "immediate" } as const;
const afterToolRound = { kind: "queue", boundary: "tool-round" } as const;
const afterAgentLoop = { kind: "queue", boundary: "agent-loop" } as const;

export const builtinCommands: Command[] = [
  {
    name: "stage",
    busyBehavior: afterAgentLoop,
    description: "Start a new Stage narrative session from two cards",
    usage: "/stage <character-card-path> <scenario-card-path>",
    completion: stageCommandCompletion,
    async run(ctx, args, raw) {
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
    async run(ctx, args) {
      await ctx.openSideQuestion(args);
    },
  },

  {
    name: "help",
    busyBehavior: immediate,
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
    name: "quality",
    busyBehavior: (args) => args.trim() === "status" ? immediate : afterAgentLoop,
    description: "Show or configure the experimental Semantic Judge",
    usage: "/quality [off|observe <provider> <model> [timeout-ms]|rewrite <provider> <model> [timeout-ms]]",
    completion: qualityCommandCompletion,
    async run(ctx, args, raw) {
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
      const parts = args.split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        await ctx.openQualityPicker();
        return;
      }
      if (parts[0] === "status" && parts.length === 1) {
        const settings = await loadExperimentalQualitySettings();
        ctx.setMessages((prev) => [...prev, { role: "system", content: renderQualitySettings(settings) }]);
        return;
      }
      if (parts[0] === "off" && parts.length === 1) {
        await writeExperimentalQualitySettings({ mode: "off" });
        ctx.setStatus("experimental Semantic Judge off");
        ctx.recordActivity({ kind: "system", text: "experimental Semantic Judge disabled" });
        ctx.setMessages((prev) => [...prev, { role: "system", content: "Experimental Semantic Judge is off. Future turns make no Judge request." }]);
        return;
      }
      const confirm = parts[0] === "confirm";
      const offset = confirm ? 1 : 0;
      const mode = parts[offset];
      const providerAlias = parts[offset + 1];
      const modelId = parts[offset + 2];
      const timeoutRaw = parts[offset + 3];
      if ((mode !== "observe" && mode !== "rewrite") || !providerAlias || !modelId || parts.length > offset + 4) {
        ctx.setMessages((prev) => [...prev, { role: "system", content: "Usage: /quality [status|off|observe <provider> <model> [timeout-ms]|rewrite <provider> <model> [timeout-ms]]." }]);
        return;
      }
      const judgeTimeoutMs = timeoutRaw ? Number(timeoutRaw) : 15_000;
      if (!Number.isInteger(judgeTimeoutMs)) {
        ctx.setMessages((prev) => [...prev, { role: "system", content: "Judge timeout must be an integer number of milliseconds." }]);
        return;
      }
      try {
        await ctx.ensureProviderRegistry();
        const config = await loadConfigForSelection({ provider: providerAlias, model: modelId });
        if (!config.apiKey) throw new Error(`Provider ${providerAlias} is missing ${config.apiKeyLabel ?? "its API key"}.`);
        if (mode === "rewrite" && !confirm) {
          ctx.setMessages((prev) => [...prev, { role: "system", content: `Experimental rewrite will send eligible narrative prose to ${providerAlias}/${modelId} and may request up to two original-Engine revisions. Confirm with /quality confirm rewrite ${providerAlias} ${modelId} ${judgeTimeoutMs}.` }]);
          return;
        }
        await writeExperimentalQualitySettings({ mode, providerAlias, modelId, judgeTimeoutMs });
        ctx.setStatus(`experimental Semantic Judge ${mode}`);
        ctx.recordActivity({ kind: "system", text: `experimental Semantic Judge ${mode} ${providerAlias}/${modelId}` });
        ctx.setMessages((prev) => [...prev, { role: "system", content: `Experimental Semantic Judge ${mode} is set to ${providerAlias}/${modelId} (${judgeTimeoutMs} ms). It is not a calibrated production quality policy.` }]);
      } catch (error) {
        ctx.setMessages((prev) => [...prev, { role: "system", content: error instanceof Error ? error.message : String(error) }]);
      }
    },
  },

  {
    name: "instructions",
    busyBehavior: () => immediate,
    description: "Show the active Persistent Instructions for this engine",
    usage: "/instructions",
    async run(ctx, _args, raw) {
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
      const selection = await resolveEffectiveSelection(ctx.activeEngine(), process.cwd());
      ctx.setMessages((prev) => [...prev, { role: "system", content: renderInstructionsNotice(selection) }]);
    },
  },

  {
    name: "permissions",
    busyBehavior: (args) => args ? afterAgentLoop : immediate,
    description: "Show or change the tool approval mode",
    usage: "/permissions [MANUAL|INERTIA|MOMENTUM|YOLO]",
    completion: fixedCommandCompletion("permissions"),
    async run(ctx, args, raw) {
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
      if (!args) {
        ctx.setMessages((prev) => [...prev, {
          role: "system",
          content: `Permission mode: ${ctx.permissionMode()}. Available: ${permissionModes.join(", ")}.`,
        }]);
        return;
      }
      const requested = args.trim().toUpperCase() as PermissionMode;
      if (!permissionModes.includes(requested)) {
        ctx.setMessages((prev) => [...prev, { role: "system", content: `Unknown permission mode "${args}". Available: ${permissionModes.join(", ")}.` }]);
        return;
      }
      await ctx.changePermissionMode(requested);
    },
  },

  {
    name: "agents",
    busyBehavior: (args) => args.trim() === "retry" ? afterAgentLoop : immediate,
    description: "List Agent Profiles and current SubAgents",
    usage: "/agents [handle|stop <handle>|retry]",
    completion: agentsCommandCompletion,
    async run(ctx, args, raw) {
      const result = await ctx.agentCommand(args);
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: result }]);
    },
  },

  {
    name: "engine",
    busyBehavior: (args) => args ? afterAgentLoop : immediate,
    description: "List or switch the Prism engine for future turns",
    usage: "/engine [id]",
    completion: engineCommandCompletion,
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
      if (engine === "stage") {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: "Stage requires /stage <character-card-path> <scenario-card-path> so its frozen bootstrap context is recorded before the first player action." }]);
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
    busyBehavior: afterAgentLoop,
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
    name: "init",
    busyBehavior: afterAgentLoop,
    description: "Scan the project and generate a VESICLE.md of persistent instructions",
    usage: "/init [notes]",
    async run(ctx, args, raw) {
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
      await ctx.initProject(args);
    },
  },

  {
    name: "context",
    busyBehavior: immediate,
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
    busyBehavior: afterAgentLoop,
    description: "Switch provider/model (no args opens a picker)",
    usage: "/model [provider] [model]",
    completion: modelCommandCompletion,
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
    busyBehavior: (args) => args ? afterAgentLoop : immediate,
    description: "Set provider thinking effort",
    usage: "/effort off|low|medium|high|xhigh|max|auto",
    completion: fixedCommandCompletion("effort"),
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
    busyBehavior: immediate,
    description: "Set reasoning display mode",
    usage: "/reasoning hidden|collapsed|expanded",
    completion: fixedCommandCompletion("reasoning"),
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
    busyBehavior: afterToolRound,
    description: "List artifacts or preview one in the message stream",
    usage: "/artifact [n|path]",
    completion: artifactCommandCompletion("artifact"),
    async run(ctx, args, raw) {
      const entries = await ctx.refreshArtifacts();
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
    busyBehavior: afterToolRound,
    description: "Validate an artifact file",
    usage: "/validate <n|path>",
    completion: artifactCommandCompletion("validate"),
    async run(ctx, args, raw) {
      const entries = await ctx.refreshArtifacts();
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
    busyBehavior: afterAgentLoop,
    aliases: ["checkpoint"],
    description: "Restore code and/or conversation to an earlier point",
    async run(ctx) {
      await ctx.openRewindPicker();
    },
  },

  {
    name: "new",
    busyBehavior: afterAgentLoop,
    description: "Start a fresh session",
    async run(ctx, _args, raw) {
      ctx.resetRewindState();
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

function renderQualitySettings(settings: Awaited<ReturnType<typeof loadExperimentalQualitySettings>>): string {
  if (settings.mode === "off") return "Experimental Semantic Judge: off. Future turns make no Judge request.";
  return `Experimental Semantic Judge: ${settings.mode} with ${settings.providerAlias}/${settings.modelId} (${settings.judgeTimeoutMs} ms). It is not calibrated production policy.`;
}

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

function renderInstructionsNotice(selection: EffectiveInstructionSelection): string {
  const lines: string[] = [`Persistent Instructions for engine "${selection.engine}":`];
  const files = [selection.user, selection.project].filter((file): file is NonNullable<typeof file> => Boolean(file));
  if (files.length === 0 && selection.diagnostics.length === 0) {
    lines.push("  No instruction files are active for this engine.");
    lines.push(`  Locations: VESICLE.md / VESICLE.<engine>.md at the project root (project scope)`);
    lines.push(`  and beside providers.yaml (user scope; applies across project roots).`);
    return lines.join("\n");
  }
  for (const file of files) {
    const scope = file.target.scope;
    const override = file.target.engine !== "all" ? ` (replaces ${scope} general; engine override ${file.target.engine})` : "";
    const empty = file.empty ? " [empty override — contributes no content]" : "";
    lines.push(`  - ${file.logicalName} [${scope}]${override}${empty} — ${file.bytes} bytes (sha256 ${file.sha256.slice(0, 8)})`);
  }
  lines.push(`  Combined budget: ${selection.combinedBytes} / ${INSTRUCTION_COMBINED_BUDGET_BYTES} bytes`);
  for (const diagnostic of selection.diagnostics) {
    lines.push(`  ! ${diagnostic.logicalName} [${diagnostic.scope}] ${diagnostic.kind}: ${diagnostic.message}`);
  }
  lines.push("  Instructions customize work within host capabilities; they cannot add tools, permissions, gates, validators, or filesystem authority.");
  return lines.join("\n");
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
