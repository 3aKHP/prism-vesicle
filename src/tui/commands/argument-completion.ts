import type { ProviderRegistry } from "../../config/providers";
import { engineIds } from "../../core/engine/profile";
import { permissionModes } from "../../core/permissions";
import { listStageCardPaths } from "../../core/stage/bootstrap";
import { reasoningTiers } from "../../providers/shared/types";
import { engineDisplayName } from "../theme";
import type { OptionItem } from "../types";
import { modelOptionItems, providerOptionItems } from "./options";
import type {
  Command,
  CommandArgumentCompletion,
  CommandCompletion,
  CommandCompletionContext,
} from "./types";

export type ModelArgumentDraft =
  | { stage: "provider"; query: string }
  | { stage: "model"; providerId: string; query: string };

export type FixedArgumentCommand = "engine" | "effort" | "reasoning" | "permissions";

export type FixedArgumentDraft = {
  command: FixedArgumentCommand;
  query: string;
};

export type AgentArgumentDraft = {
  stage: "command" | "stop";
  query: string;
};

/** Parse the editable portion after `/model ` into its established completion stage. */
export function parseModelArgumentDraft(value: string): ModelArgumentDraft | null {
  if (value.length < 7 || value.slice(0, 7).toLowerCase() !== "/model ") return null;
  const rest = value.slice(7);
  const separator = rest.indexOf(" ");
  if (separator === -1) return { stage: "provider", query: rest };
  const providerId = rest.slice(0, separator);
  if (!providerId) return { stage: "provider", query: rest.trimStart() };
  return { stage: "model", providerId, query: rest.slice(separator + 1) };
}

/** Parse commands whose first argument comes from a fixed enum. */
export function parseFixedArgumentDraft(value: string): FixedArgumentDraft | null {
  const separator = value.indexOf(" ");
  if (!value.startsWith("/") || separator === -1) return null;
  const command = value.slice(1, separator).toLowerCase();
  if (!isFixedArgumentCommand(command)) return null;
  return { command, query: value.slice(separator + 1) };
}

export function parseAgentArgumentDraft(value: string): AgentArgumentDraft | null {
  if (value.length < 8 || value.slice(0, 8).toLowerCase() !== "/agents ") return null;
  const rest = value.slice(8);
  if (rest.toLowerCase().startsWith("stop ")) return { stage: "stop", query: rest.slice(5) };
  return { stage: "command", query: rest };
}

export function fixedArgumentOptions(command: FixedArgumentCommand): OptionItem[] {
  if (command === "engine") {
    return engineIds.filter((engine) => engine !== "stage").map((engine) => ({
      id: engine,
      label: engine,
      detail: `${engineDisplayName(engine)} profile`,
    }));
  }
  if (command === "effort") {
    const details: Record<(typeof reasoningTiers)[number], string> = {
      off: "Disable provider thinking",
      low: "Low thinking effort",
      medium: "Medium thinking effort",
      high: "High thinking effort",
      xhigh: "Extra-high thinking effort",
      max: "Maximum thinking effort",
    };
    return [
      ...reasoningTiers.map((tier) => ({ id: tier, label: tier, detail: details[tier] })),
      { id: "auto", label: "auto", detail: "Provider default · aliases: unset, default" },
    ];
  }
  if (command === "permissions") {
    const details = {
      MANUAL: "Ask before every model-visible tool",
      INERTIA: "Auto-allow observation tools",
      MOMENTUM: "Auto-allow every tool except shell_exec",
      YOLO: "Auto-allow all effective tools · requires two confirmations",
    } as const;
    return permissionModes.map((mode) => ({ id: mode, label: mode, detail: details[mode] }));
  }
  return [
    { id: "hidden", label: "hidden", detail: "Hide reasoning · aliases: hide, off" },
    { id: "collapsed", label: "collapsed", detail: "Bounded preview · aliases: fold, preview" },
    { id: "expanded", label: "expanded", detail: "Show full reasoning · aliases: expand, show, on" },
  ];
}

/** Prefix-first filtering shared by every command-owned argument popup. */
export function matchOptionItems(query: string, items: readonly OptionItem[]): OptionItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...items];
  return items
    .map((item, index) => ({ item, index, score: optionScore(normalized, item) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.item);
}

export function completeModelArgument(draft: ModelArgumentDraft, item: OptionItem): string {
  return draft.stage === "provider"
    ? `/model ${item.id} `
    : `/model ${draft.providerId} ${item.id}`;
}

export function completeFixedArgument(draft: FixedArgumentDraft, item: OptionItem): string {
  return `/${draft.command} ${item.id}`;
}

export function completeAgentArgument(draft: AgentArgumentDraft, item: OptionItem): string {
  if (draft.stage === "stop") return `/agents stop ${item.id}`;
  return item.id === "stop" ? "/agents stop " : `/agents ${item.id}`;
}

/** Preserve the existing provider-first /model interaction, including its item order. */
export const modelCommandCompletion: CommandCompletion = {
  resolve(value, context) {
    const draft = parseModelArgumentDraft(value);
    if (!draft) return null;
    const registry = context.providerRegistry();
    if (!registry) return completion(`model:${draft.stage}`, value, draft.query, "providers", [], () => "");
    if (draft.stage === "model") {
      return completion(
        `model:model:${draft.providerId}`,
        value,
        draft.query,
        `models · ${draft.providerId}`,
        modelOptionItems(registry, draft.providerId),
        (item) => completeModelArgument(draft, item),
      );
    }

    const providers = providerOptionItems(registry);
    const exactProvider = providers.some((provider) => provider.id.toLowerCase() === draft.query.trim().toLowerCase());
    // The visible first stage remains provider-first. Once the typed text does
    // not exactly select a provider, active-provider models fill the historic
    // `/model <model>` shorthand without changing explicit-provider behaviour.
    const shorthandModels = draft.query.trim() && !exactProvider
      ? modelOptionItems(registry, context.activeProvider())
      : [];
    return completion(
      "model:provider",
      value,
      draft.query,
      draft.query.trim() ? "providers · active-provider models" : "providers",
      [...providers, ...shorthandModels],
      (item) => providers.some((provider) => provider.id === item.id)
        ? completeModelArgument(draft, item)
        : `/model ${item.id}`,
    );
  },
};

export function fixedCommandCompletion(command: FixedArgumentCommand): CommandCompletion {
  return {
    resolve(value) {
      const draft = parseFixedArgumentDraft(value);
      if (!draft || draft.command !== command) return null;
      return completion(
        `fixed:${command}`,
        value,
        draft.query,
        command,
        fixedArgumentOptions(command),
        (item) => completeFixedArgument(draft, item),
      );
    },
  };
}

export const agentsCommandCompletion: CommandCompletion = {
  resolve(value, context) {
    const draft = parseAgentArgumentDraft(value);
    if (!draft) return null;
    const handles = context.agentOptions();
    const candidates = draft.stage === "command"
      ? [
          { id: "stop", label: "stop", detail: "Interrupt a running SubAgent" },
          { id: "retry", label: "retry", detail: "Retry paused background-result delivery" },
          ...handles,
        ]
      : handles.filter((item) => item.detail?.startsWith("queued") || item.detail?.startsWith("running"));
    return completion(
      `agents:${draft.stage}`,
      value,
      draft.query,
      draft.stage === "stop" ? "running agents" : "agents",
      candidates,
      (item) => completeAgentArgument(draft, item),
    );
  },
};

export const engineCommandCompletion: CommandCompletion = {
  resolve(value) {
    const args = commandArguments(value, "engine");
    if (args === null) return null;
    const tokens = splitTokens(args);
    if (tokens.values.length === 0 || (tokens.values.length === 1 && !tokens.trailingSpace)) {
      return completion("engine:id", value, tokens.values[0] ?? "", "engines", fixedArgumentOptions("engine"), (item) => `/engine ${item.id}`);
    }
    if ((tokens.values.length === 1 && tokens.trailingSpace) || (tokens.values.length === 2 && !tokens.trailingSpace)) {
      return completion("engine:summary", value, tokens.values[1] ?? "", "engine options", [
        { id: "--summary", label: "--summary", detail: "Compact context before switching" },
      ], (item) => `/engine ${tokens.values[0]} ${item.id} `);
    }
    return null;
  },
};

export const qualityCommandCompletion: CommandCompletion = {
  resolve(value, context) {
    const args = commandArguments(value, "quality");
    if (args === null) return null;
    const tokens = splitTokens(args);
    const [first, second, third] = tokens.values;
    const fixedModes = [
      { id: "status", label: "status", detail: "Show Semantic Judge settings" },
      { id: "off", label: "off", detail: "Disable the Semantic Judge" },
      { id: "observe", label: "observe", detail: "Record advisory Judge findings" },
      { id: "rewrite", label: "rewrite", detail: "Configure rewrite mode" },
      { id: "confirm", label: "confirm", detail: "Confirm rewrite mode" },
    ];
    if (!first || (!tokens.trailingSpace && tokens.values.length === 1)) {
      return completion("quality:mode", value, first ?? "", "quality modes", fixedModes, (item) => {
        if (item.id === "status" || item.id === "off") return `/quality ${item.id}`;
        return `/quality ${item.id} `;
      });
    }
    const confirmed = first === "confirm";
    if (confirmed && (!second || (!tokens.trailingSpace && tokens.values.length === 2))) {
      return completion("quality:confirm-mode", value, second ?? "", "rewrite confirmation", [
        { id: "rewrite", label: "rewrite", detail: "Confirm rewrite mode" },
      ], () => "/quality confirm rewrite ");
    }
    const mode = confirmed ? second : first;
    const providerIndex = confirmed ? 2 : 1;
    if (mode !== "observe" && mode !== "rewrite") return null;
    const provider = tokens.values[providerIndex];
    const model = tokens.values[providerIndex + 1];
    const registry = context.providerRegistry();
    const prefix = confirmed ? `/quality confirm ${mode}` : `/quality ${mode}`;
    if (!provider || (!tokens.trailingSpace && tokens.values.length === providerIndex + 1)) {
      return completion(
        `quality:${confirmed ? "confirm:" : ""}${mode}:provider`,
        value,
        provider ?? "",
        "providers",
        registry ? providerOptionItems(registry) : [],
        (item) => `${prefix} ${item.id} `,
      );
    }
    if (!model || (!tokens.trailingSpace && tokens.values.length === providerIndex + 2)) {
      return completion(
        `quality:${confirmed ? "confirm:" : ""}${mode}:model:${provider}`,
        value,
        model ?? "",
        `models · ${provider}`,
        registry ? modelOptionItems(registry, provider) : [],
        (item) => `${prefix} ${provider} ${item.id} `,
      );
    }
    return null;
  },
};

export function artifactCommandCompletion(command: "artifact" | "validate"): CommandCompletion {
  return {
    resolve(value, context) {
      const args = commandArguments(value, command);
      if (args === null || /\s/.test(args.trim())) return null;
      return completion(
        `${command}:artifacts`,
        value,
        args,
        "artifacts",
        async () => (await context.refreshArtifacts()).map((artifact, index) => ({
          id: artifact.path,
          label: artifact.path,
          detail: `${index + 1} · ${artifact.updatedAt}`,
        })),
        (item) => `/${command} ${item.id}`,
      );
    },
  };
}

export const resumeCommandCompletion: CommandCompletion = {
  resolve(value, context) {
    const args = commandArguments(value, "resume");
    if (args === null || /\s/.test(args.trim())) return null;
    return completion(
      "resume:sessions",
      value,
      args,
      "resumable sessions",
      async () => (await context.listSessions()).map((session, index) => ({
        id: session.sessionId,
        label: session.sessionId,
        detail: `${index + 1} · ${session.preview}`,
      })),
      (item) => `/resume ${item.id}`,
    );
  },
};

export const stageCommandCompletion: CommandCompletion = {
  resolve(value, context) {
    const args = commandArguments(value, "stage");
    if (args === null) return null;
    const tokens = splitTokens(args);
    if (tokens.values.length >= 2) return null;
    const firstPath = tokens.values[0];
    const selectingSecond = Boolean(firstPath && tokens.trailingSpace);
    return completion(
      `stage:${selectingSecond ? "scenario" : "character"}`,
      value,
      selectingSecond ? "" : firstPath ?? "",
      selectingSecond ? "scenario cards" : "character cards",
      async () => (await listStageCardPaths(context.rootDir)).map((path) => ({
        id: path,
        label: path,
        detail: "guarded project-relative file",
      })),
      (item) => selectingSecond
        ? `/stage ${quoteArgument(firstPath!)} ${quoteArgument(item.id)}`
        : `/stage ${quoteArgument(item.id)} `,
    );
  },
};

/** Resolve the canonical command's completion contract, preserving aliases as input only. */
export function resolveCommandArgumentCompletion(
  value: string,
  commands: readonly Command[],
  context: CommandCompletionContext,
): CommandArgumentCompletion | null {
  const name = commandName(value);
  if (!name) return null;
  const command = commands.find((candidate) => candidate.name === name || candidate.aliases?.includes(name));
  if (!command?.completion) return null;
  const canonicalDraft = `/${command.name}${value.slice(name.length + 1)}`;
  return command.completion.resolve(canonicalDraft, context);
}

function completion(
  sourceKey: string,
  value: string,
  query: string,
  hint: string,
  items: CommandArgumentCompletion["items"],
  complete: (item: OptionItem) => string,
): CommandArgumentCompletion {
  return { sourceKey, selectionKey: `${sourceKey}:${value}`, query, hint, items, complete };
}

function commandArguments(value: string, command: string): string | null {
  const match = value.match(/^\/([^\s]+)(?:\s([\s\S]*))?$/);
  if (!match || match[1]?.toLowerCase() !== command) return null;
  return match[2] ?? null;
}

function commandName(value: string): string | null {
  const match = value.match(/^\/([^\s]+)/);
  return match?.[1]?.toLowerCase() ?? null;
}

function splitTokens(value: string): { values: string[]; trailingSpace: boolean } {
  const values = value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
  return { values, trailingSpace: /\s$/.test(value) };
}

function quoteArgument(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function isFixedArgumentCommand(value: string): value is FixedArgumentCommand {
  return value === "engine" || value === "effort" || value === "reasoning" || value === "permissions";
}

function optionScore(query: string, item: OptionItem): number {
  const id = item.id.toLowerCase();
  const label = item.label.toLowerCase();
  if (id === query || label === query) return 0;
  if (id.startsWith(query) || label.startsWith(query)) return 1;
  if (id.includes(query) || label.includes(query)) return 2;
  if (item.detail?.toLowerCase().includes(query)) return 3;
  return -1;
}
