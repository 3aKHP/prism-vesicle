// Built-in slash commands. Each branch of the former handleCommand if-else is
// now a Command object whose run() receives `args` for parsed arguments and
// `raw` for the original input, while TUI closures are reached through the
// CommandContext `ctx`.

import { engineIds } from "../../core/engine/profile";
import { resolveAutoCompactActivation } from "../../core/compact/context-budget";
import type { EngineId } from "../../core/engine/profile";
import { createManualEngineTransition } from "../../core/engine/transition";
import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import {
  defaultExperimentalQualityTimeoutMs,
  loadExperimentalQualitySettings,
  writeExperimentalQualitySettings,
} from "../../config/quality";
import { resolveQualityCandidate } from "../quality-picker-controller";
import type { Command } from "./types";
import { permissionModes, type PermissionMode } from "../../core/permissions";
import {
  parseEngineId,
  parseInitCommandArgs,
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
  themeCommandCompletion,
} from "./argument-completion";
import {
  renderValidationNotice,
  renderEngineList,
} from "./render";
import { INSTRUCTION_COMBINED_BUDGET_BYTES, resolveEffectiveSelection } from "../../core/instructions";
import type { EffectiveInstructionSelection } from "../../core/instructions";
import { type ThemePreference } from "../theme";

const HELP_TEXT = [
  "Commands:",
  "  /model [provider] [model]  switch provider/model (no args = pick)",
  "  /engine [id] [--summary [notes]] list or switch the Prism engine",
  "  /stage <character-card-path> <scenario-card-path> start a new Stage narrative session",
  "  /compact [notes]  summarize this session and replace old context",
  "  /init [--force] [notes] scan the project and generate a VESICLE.md of persistent instructions",
  "  /context          show current context window usage",
  "  /instructions     show active Persistent Instructions for this engine",
  "  /agents [handle|stop <handle>|retry] list, inspect, interrupt, or retry SubAgent delivery",
  "  /effort <tier>    set thinking effort: off/low/medium/high/xhigh/max/auto",
  "  /reasoning <mode> show reasoning: hidden/collapsed/expanded (aliases: off/preview/on)",
  "  /theme [dark|light|default|auto] show or set the colour theme (default follows the terminal; auto follows the clock)",
  "  /workspace [path] open the Workspace page, optionally locating a file or directory",
  "  /permissions [mode] show or set MANUAL/INERTIA/MOMENTUM/YOLO tool approval mode",
  "  /quality          show or configure the experimental Semantic Judge (no args = guided settings)",
  "  /artifact [n|path] open artifacts in the Workspace page (no args = latest)",
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
    description: "Show or configure the experimental Semantic Judge (no args = guided settings)",
    usage: "/quality [status|off|observe [provider model [timeout-ms]]|rewrite [provider model [timeout-ms]]]",
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
      // /quality confirm ... is no longer supported: Rewrite opens one modal
      // confirmation panel. Reject it as invalid usage with no mutation.
      if (parts[0] === "confirm") {
        ctx.setMessages((prev) => [...prev, { role: "system", content: `${QUALITY_USAGE}\nThe /quality confirm step was removed. Selecting Review and revise (or running /quality rewrite) opens one confirmation panel; no second command is needed.` }]);
        return;
      }
      if (parts[0] === "off" && parts.length === 1) {
        await disableQuality(ctx);
        return;
      }
      const mode = parts[0];
      if (mode !== "observe" && mode !== "rewrite") {
        ctx.setMessages((prev) => [...prev, { role: "system", content: QUALITY_USAGE }]);
        return;
      }
      if (parts.length === 2 || parts.length > 4) {
        ctx.setMessages((prev) => [...prev, { role: "system", content: QUALITY_USAGE }]);
        return;
      }
      if (parts.length === 1) {
        await runBareQualityMode(ctx, mode);
        return;
      }
      // explicit advanced shortcut: /quality <mode> <provider> <model> [timeout-ms]
      const providerAlias = parts[1]!;
      const modelId = parts[2]!;
      const judgeTimeoutMs = parts.length === 4 ? parseQualityTimeout(parts[3]!) : defaultExperimentalQualityTimeoutMs;
      if (judgeTimeoutMs === undefined) {
        ctx.setMessages((prev) => [...prev, { role: "system", content: "Judge timeout must be an integer number of milliseconds." }]);
        return;
      }
      await runExplicitQualityMode(ctx, mode, providerAlias, modelId, judgeTimeoutMs);
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
    usage: "/init [--force] [notes]",
    async run(ctx, args, raw) {
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
    name: "theme",
    busyBehavior: immediate,
    description: "Show or set the colour theme",
    usage: "/theme [dark|light|default|auto] [--persist] [--unset-project]",
    completion: themeCommandCompletion,
    async run(ctx, args, raw) {
      const parsed = parseThemeArgs(args);
      if ("error" in parsed) {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: parsed.error }]);
        return;
      }
      if (parsed.kind === "status") {
        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: raw },
          { role: "system", content: ctx.theme.statusText() },
        ]);
        return;
      }
      if (parsed.kind === "unset-project") {
        try {
          await ctx.theme.unsetProject();
          ctx.setStatus("theme project preference unset");
          ctx.recordActivity({ kind: "system", text: "theme project preference unset" });
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: "Removed the project theme preference and cleared the session override." }]);
        } catch (error) {
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: error instanceof Error ? error.message : String(error) }]);
        }
        return;
      }
      // override or persist
      if (parsed.kind === "persist") {
        try {
          await ctx.theme.persistProject(parsed.pref);
          ctx.setStatus(`theme ${parsed.pref} persisted`);
          ctx.recordActivity({ kind: "system", text: `theme ${parsed.pref} persisted to project` });
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: `Theme ${parsed.pref} saved to .vesicle/preferences.yaml and applied for this session.` }]);
        } catch (error) {
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: error instanceof Error ? error.message : String(error) }]);
        }
        return;
      }
      ctx.theme.applyOverride(parsed.pref);
      ctx.setStatus(`theme ${parsed.pref}`);
      ctx.recordActivity({ kind: "system", text: `theme ${parsed.pref}` });
      ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: `Theme set to ${parsed.pref} for this session.` }]);
    },
  },

  {
    name: "workspace",
    busyBehavior: immediate,
    description: "Open the Workspace page, optionally locating a file or directory",
    usage: "/workspace [path]",
    async run(ctx, args, raw) {
      const located = await ctx.openWorkspaceTarget(args.trim() || undefined);
      ctx.setStatus("workspace page");
      ctx.setMessages((prev) => [
        ...prev,
        { role: "user", content: raw },
        {
          role: "system",
          content: args.trim()
            ? located
              ? `Opened ${args.trim()} in the Workspace page.`
              : `Workspace page open — "${args.trim()}" was not found in the project.`
            : "Workspace page open. Ctrl+O switches pages, Ctrl+P quick open, F6 cycles regions.",
        },
      ]);
    },
  },

  {
    name: "artifact",
    busyBehavior: afterToolRound,
    description: "Open artifacts in the Workspace page (no args = latest)",
    usage: "/artifact [n|path]",
    completion: artifactCommandCompletion("artifact"),
    async run(ctx, args, raw) {
      const entries = await ctx.refreshArtifacts();
      if (!args) {
        const latest = entries[0];
        await ctx.openWorkspaceTarget(latest?.path);
        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: raw },
          {
            role: "system",
            content: latest
              ? `Opened latest artifact ${latest.path} in the Workspace page.`
              : "Workspace page open — no artifacts yet.",
          },
        ]);
        return;
      }
      const artifact = resolveArtifactTarget(entries, args);
      if (!artifact) {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: `No artifact matches "${args}". Use /artifact to open the latest.` }]);
        return;
      }
      await ctx.openWorkspaceTarget(artifact.path);
      ctx.setMessages((prev) => [
        ...prev,
        { role: "user", content: raw },
        { role: "system", content: `Opened ${artifact.path} in the Workspace page.` },
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
  const tuple = qualityTuple(settings);
  if (settings.mode === "off") {
    return tuple
      ? `Experimental Semantic Judge: off (inactive). Retained profile: ${tuple.providerAlias}/${tuple.modelId} (${tuple.judgeTimeoutMs} ms). No Judge request is made while off.`
      : "Experimental Semantic Judge: off. Future turns make no Judge request.";
  }
  return `Experimental Semantic Judge: ${settings.mode} with ${settings.providerAlias}/${settings.modelId} (${settings.judgeTimeoutMs} ms). It is not calibrated production policy.`;
}

const QUALITY_USAGE = "Usage: /quality [status|off|observe [provider model [timeout-ms]]|rewrite [provider model [timeout-ms]]]. No arguments open guided settings.";

function qualityTuple(settings: Awaited<ReturnType<typeof loadExperimentalQualitySettings>>): { providerAlias: string; modelId: string; judgeTimeoutMs: number } | undefined {
  if (settings.providerAlias && settings.modelId && settings.judgeTimeoutMs !== undefined) {
    return { providerAlias: settings.providerAlias, modelId: settings.modelId, judgeTimeoutMs: settings.judgeTimeoutMs };
  }
  return undefined;
}

function parseQualityTimeout(raw: string): number | undefined {
  if (!/^[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

async function disableQuality(ctx: Parameters<Command["run"]>[0]): Promise<void> {
  const settings = await loadExperimentalQualitySettings();
  const retained = qualityTuple(settings);
  if (retained) {
    await writeExperimentalQualitySettings({ mode: "off", providerAlias: retained.providerAlias, modelId: retained.modelId, judgeTimeoutMs: retained.judgeTimeoutMs });
  } else {
    await writeExperimentalQualitySettings({ mode: "off" });
  }
  ctx.setStatus("experimental Semantic Judge off");
  ctx.recordActivity({ kind: "system", text: "experimental Semantic Judge disabled" });
  ctx.setMessages((prev) => [...prev, {
    role: "system",
    content: retained
      ? `Experimental Semantic Judge is off. The Judge profile ${retained.providerAlias}/${retained.modelId} is retained for later reuse; no Judge request is made while off.`
      : "Experimental Semantic Judge is off. Future turns make no Judge request.",
  }]);
}

/**
 * Bare `/quality observe|rewrite` without an explicit profile. Observe enables
 * immediately only when a retained valid profile exists; otherwise it opens the
 * guided picker with the active provider/model preselected. Rewrite resolves the
 * retained-or-active candidate and opens the red confirmation panel directly.
 */
async function runBareQualityMode(ctx: Parameters<Command["run"]>[0], mode: "observe" | "rewrite"): Promise<void> {
  if (mode === "rewrite") {
    try {
      const registry = await ctx.ensureProviderRegistry();
      const settings = await loadExperimentalQualitySettings();
      const { candidate } = resolveQualityCandidate(settings, registry, ctx.activeProvider(), ctx.activeModel());
      await validateQualityCandidate(candidate.providerAlias, candidate.modelId);
      await ctx.openQualityRewriteConfirm(candidate);
    } catch (error) {
      ctx.setMessages((prev) => [...prev, { role: "system", content: error instanceof Error ? error.message : String(error) }]);
    }
    return;
  }
  // bare observe
  try {
    const registry = await ctx.ensureProviderRegistry();
    const settings = await loadExperimentalQualitySettings();
    const retained = qualityTuple(settings);
    if (retained && registry.providers.some((provider) => provider.id === retained.providerAlias && provider.models.some((model) => model.id === retained.modelId))) {
      await validateQualityCandidate(retained.providerAlias, retained.modelId);
      await writeExperimentalQualitySettings({ mode: "observe", providerAlias: retained.providerAlias, modelId: retained.modelId, judgeTimeoutMs: retained.judgeTimeoutMs });
      ctx.setStatus("experimental Semantic Judge observe");
      ctx.recordActivity({ kind: "system", text: `experimental Semantic Judge observe ${retained.providerAlias}/${retained.modelId}` });
      ctx.setMessages((prev) => [...prev, { role: "system", content: `Experimental Semantic Judge observe is set to ${retained.providerAlias}/${retained.modelId} (${retained.judgeTimeoutMs} ms). It is not a calibrated production quality policy.` }]);
      return;
    }
  } catch (error) {
    ctx.setMessages((prev) => [...prev, { role: "system", content: error instanceof Error ? error.message : String(error) }]);
    return;
  }
  // No retained valid profile: open the picker focused on Review only. The
  // candidate (active provider/model) is visibly preselected by the picker.
  await ctx.openQualityPicker("observe");
}

/** Explicit `/quality observe|rewrite <provider> <model> [timeout]` advanced shortcut. */
async function runExplicitQualityMode(
  ctx: Parameters<Command["run"]>[0],
  mode: "observe" | "rewrite",
  providerAlias: string,
  modelId: string,
  judgeTimeoutMs: number,
): Promise<void> {
  try {
    await ctx.ensureProviderRegistry();
    await validateQualityCandidate(providerAlias, modelId);
    if (mode === "rewrite") {
      await ctx.openQualityRewriteConfirm({ providerAlias, modelId, judgeTimeoutMs });
      return;
    }
    await writeExperimentalQualitySettings({ mode, providerAlias, modelId, judgeTimeoutMs });
    ctx.setStatus(`experimental Semantic Judge ${mode}`);
    ctx.recordActivity({ kind: "system", text: `experimental Semantic Judge ${mode} ${providerAlias}/${modelId}` });
    ctx.setMessages((prev) => [...prev, { role: "system", content: `Experimental Semantic Judge ${mode} is set to ${providerAlias}/${modelId} (${judgeTimeoutMs} ms). It is not a calibrated production quality policy.` }]);
  } catch (error) {
    ctx.setMessages((prev) => [...prev, { role: "system", content: error instanceof Error ? error.message : String(error) }]);
  }
}

async function validateQualityCandidate(providerAlias: string, modelId: string): Promise<void> {
  const config = await loadConfigForSelection({ provider: providerAlias, model: modelId });
  if (!config.apiKey) throw new Error(`Provider ${providerAlias} is missing ${config.apiKeyLabel ?? "its API key"}.`);
}

export function renderContextStatus(ctx: Parameters<Command["run"]>[0]): string {
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
    lines.push(`Used: ${formatTokenCount(contextInput)} / ${formatTokenCount(contextWindow)} (${formatPercent(contextInput, contextWindow)}) — provider usage`);
  } else {
    lines.push(`Context window: ${formatTokenCount(contextWindow)}`);
    lines.push("Used: no provider usage yet");
  }

  // Truthful activation state (issue #107 §9): report active/inactive with the
  // precise reason, the effective soft/hard limits, the reserve and its source,
  // and the active strategy. Never claim protection without a configured
  // window + threshold; the old "enabled at N%" line could fire with neither.
  const activation = resolveAutoCompactActivation({
    config: limits?.autoCompact,
    limits,
    generation: ctx.activeModelGeneration(),
  });
  if (activation.kind === "active") {
    lines.push(`Soft trigger: ${formatTokenCount(activation.softTriggerTokens)} (${Math.round(activation.threshold * 100)}% of window)`);
    lines.push(`Hard input ceiling: ${formatTokenCount(activation.hardInputCeilingTokens)}`);
    lines.push(`Output reserve: ${formatTokenCount(activation.reserveTokens)} (${reserveSourceLabel(activation.reserveSource)})`);
    lines.push("Auto compact: active · strategy portable-summary");
  } else if (limits?.autoCompact) {
    lines.push(`Auto compact: inactive · ${inactiveReasonLabel(activation.reason)}`);
  } else {
    lines.push("Auto compact: not configured");
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

function reserveSourceLabel(source: "explicit" | "generation-maxTokens" | "model-maxOutputTokens" | "zero"): string {
  switch (source) {
    case "explicit": return "from autoCompact.reserveOutputTokens";
    case "generation-maxTokens": return "from generation maxTokens";
    case "model-maxOutputTokens": return "from limits.maxOutputTokens";
    case "zero": return "no reserve configured";
  }
}

function inactiveReasonLabel(reason: "missing-config" | "disabled" | "missing-threshold" | "invalid-threshold" | "missing-context-window" | "invalid-reserve"): string {
  switch (reason) {
    case "missing-config": return "autoCompact block absent";
    case "disabled": return "enabled: false";
    case "missing-threshold": return "threshold not set";
    case "invalid-threshold": return "threshold not strictly between 0 and 1";
    case "missing-context-window": return "limits.contextWindow not set";
    case "invalid-reserve": return "reserveOutputTokens makes the effective input budget non-positive";
  }
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

const THEME_PREFERENCES: readonly ThemePreference[] = ["dark", "light", "default", "auto"];
const THEME_USAGE = "Usage: /theme [dark|light|default|auto] [--persist] [--unset-project].\ndefault follows the terminal; auto follows the clock (light 07:00–19:00).";

type ThemeArgs =
  | { kind: "status" }
  | { kind: "override"; pref: ThemePreference }
  | { kind: "persist"; pref: ThemePreference }
  | { kind: "unset-project" }
  | { error: string };

/**
 * Parse the `/theme` grammar (plan §8.4):
 *   /theme                                  status
 *   /theme dark|light|default|auto          session override
 *   /theme dark|light|default|auto --persist project persist + session override
 *   /theme --unset-project                  remove project theme + clear override
 * Extra arguments, repeated --persist, or --unset-project combined with a
 * preference are usage errors with no mutation.
 */
function parseThemeArgs(args: string): ThemeArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "status" };
  const persistCount = tokens.filter((token) => token === "--persist").length;
  const hasUnset = tokens.includes("--unset-project");
  const operands = tokens.filter((token) => token !== "--persist" && token !== "--unset-project");

  if (hasUnset) {
    if (operands.length > 0 || persistCount > 0) return { error: THEME_USAGE };
    return { kind: "unset-project" };
  }
  if (persistCount > 1) return { error: THEME_USAGE };
  if (operands.length > 1) return { error: THEME_USAGE };
  if (persistCount === 1) {
    if (operands.length !== 1) return { error: THEME_USAGE };
    const pref = operands[0]!.toLowerCase();
    if (!THEME_PREFERENCES.includes(pref as ThemePreference)) return { error: THEME_USAGE };
    return { kind: "persist", pref: pref as ThemePreference };
  }
  const pref = operands[0]!.toLowerCase();
  if (!THEME_PREFERENCES.includes(pref as ThemePreference)) return { error: THEME_USAGE };
  return { kind: "override", pref: pref as ThemePreference };
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
