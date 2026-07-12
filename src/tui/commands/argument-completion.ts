import type { OptionItem } from "../types";
import { engineIds } from "../../core/engine/profile";
import { reasoningTiers } from "../../providers/shared/types";
import { engineDisplayName } from "../theme";

export type ModelArgumentDraft =
  | { stage: "provider"; query: string }
  | { stage: "model"; providerId: string; query: string };

export type FixedArgumentCommand = "engine" | "effort" | "reasoning";

export type FixedArgumentDraft = {
  command: FixedArgumentCommand;
  query: string;
};

export type AgentArgumentDraft = {
  stage: "command" | "stop";
  query: string;
};

/** Parse the editable portion after `/model ` into its completion stage. */
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
    return engineIds.map((engine) => ({
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
  return [
    { id: "hidden", label: "hidden", detail: "Hide reasoning · aliases: hide, off" },
    { id: "collapsed", label: "collapsed", detail: "Bounded preview · aliases: fold, preview" },
    { id: "expanded", label: "expanded", detail: "Show full reasoning · aliases: expand, show, on" },
  ];
}

/** Prefix-first filtering shared by fixed and dynamic argument popup rows. */
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

function isFixedArgumentCommand(value: string): value is FixedArgumentCommand {
  return value === "engine" || value === "effort" || value === "reasoning";
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
