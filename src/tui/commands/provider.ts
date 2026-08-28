// /model, /effort, /reasoning, /context — provider/model selection, thinking
// effort, reasoning display, and context-window status. Grouped because they
// all read or mutate provider/model configuration and share the usage/limits
// accessors.

import { afterAgentLoop, immediate, parseEffortTier, parseReasoningDisplayMode } from "./dispatch";
import { fixedCommandCompletion, modelCommandCompletion } from "./argument-completion";
import type { ProviderSelection } from "../../config/providers";
import { resolveAutoCompactActivation } from "../../core/compact/context-budget";
import type { Command, ProviderCommandContext } from "./types";

export function createProviderCommands(ctx: ProviderCommandContext): Command[] {
  return [
    {
      name: "context",
      busyBehavior: immediate,
      description: "Show current context window usage",
      usage: "/context",
      completion: null,
      async run(_args, raw) {
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
      async run(args, raw) {
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
      async run(args, raw) {
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
      async run(args, raw) {
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
  ];
}

export function renderContextStatus(ctx: ProviderCommandContext): string {
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
