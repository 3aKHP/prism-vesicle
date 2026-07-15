// Slash-command parsing, resolution, and dispatch, plus the pure parse/target
// helpers the command bodies share. Extracted from app.tsx's handleCommand —
// behaviour unchanged. dispatch depends only on types + external modules; it
// does NOT import builtin, so builtin -> dispatch is a one-way edge.

import { engineIds } from "../../core/engine/profile";
import type { EngineId } from "../../core/engine/profile";
import { reasoningTiers } from "../../providers/shared/types";
import type { ReasoningTier } from "../../providers/shared/types";
import type { ReasoningDisplayMode, SessionSummary } from "../../core/session/store";
import type { ArtifactEntry } from "../../core/artifacts/workbench";
import type { Command, CommandContext } from "./types";

/** Split "/engine runtime extra" into { name: "engine", args: "runtime extra" }. */
export function parseSlashInput(raw: string): { name: string; args: string } {
  const [command, ...rest] = raw.slice(1).split(/\s+/);
  return { name: command ?? "", args: rest.join(" ").trim() };
}

/** Find a command by name or alias. */
export function resolveCommand(name: string, commands: readonly Command[]): Command | null {
  return commands.find((cmd) => cmd.name === name || cmd.aliases?.includes(name)) ?? null;
}

/**
 * Parse + resolve + run. Unknown commands echo a host notice, mirroring the
 * old handleCommand tail.
 */
export async function executeCommand(raw: string, ctx: CommandContext, commands: readonly Command[]): Promise<void> {
  const { name, args } = parseSlashInput(raw);
  const command = resolveCommand(name, commands);
  if (!command) {
    const label = name || "(empty)";
    ctx.setMessages((prev) => [
      ...prev,
      { role: "user", content: raw },
      { role: "system", content: `Unknown command: /${label}. Type /help for available commands.` },
    ]);
    return;
  }
  await command.run(ctx, args, raw);
}

// —— pure parse / target helpers (moved verbatim from app.tsx) ——

export function parseEngineId(value: string): EngineId | null {
  const normalized = value.trim().toLowerCase();
  return (engineIds as readonly string[]).includes(normalized) ? (normalized as EngineId) : null;
}

export function parseEffortTier(value: string): ReasoningTier | "auto" | null {
  const raw = value.trim().toLowerCase();
  if (raw === "auto" || raw === "unset" || raw === "default") return "auto";
  return (reasoningTiers as readonly string[]).includes(raw) ? (raw as ReasoningTier) : null;
}

export function parseReasoningDisplayMode(value: string): ReasoningDisplayMode | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "hide" || normalized === "hidden" || normalized === "off") return "hidden";
  if (normalized === "collapse" || normalized === "collapsed" || normalized === "fold" || normalized === "preview") return "collapsed";
  if (normalized === "expand" || normalized === "expanded" || normalized === "show" || normalized === "on") return "expanded";
  return null;
}

export function resolveArtifactTarget(entries: ArtifactEntry[], arg: string): ArtifactEntry | null {
  const trimmed = arg.trim();
  if (!trimmed) return entries[0] ?? null;
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= entries.length) return entries[numeric - 1];
  return entries.find((entry) => entry.path === trimmed) ?? null;
}

export function resolveSessionTarget(sessions: SessionSummary[], arg: string): SessionSummary | null {
  // Numeric index (1-based) into the most recent /resume list.
  const numeric = Number(arg);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= sessions.length) {
    return sessions[numeric - 1];
  }
  // Otherwise treat as an id prefix.
  return sessions.find((s) => s.sessionId.startsWith(arg)) ?? null;
}
