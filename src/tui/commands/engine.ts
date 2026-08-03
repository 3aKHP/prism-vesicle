// /engine, /instructions — Prism engine switch (with optional pre-switch
// compaction) and active Persistent Instructions resolution.

import { afterAgentLoop, immediate, parseEngineId } from "./dispatch";
import { engineIds } from "../../core/engine/profile";
import type { EngineId } from "../../core/engine/profile";
import { createManualEngineTransition } from "../../core/engine/transition";
import { engineCommandCompletion } from "./argument-completion";
import { renderEngineList } from "./render";
import { INSTRUCTION_COMBINED_BUDGET_BYTES, resolveEffectiveSelection } from "../../core/instructions";
import type { EffectiveInstructionSelection } from "../../core/instructions";
import type { Command, EngineCommandContext } from "./types";

export function createEngineCommands(ctx: EngineCommandContext): Command[] {
  return [
    {
      name: "engine",
      busyBehavior: (args) => args ? afterAgentLoop : immediate,
      description: "List or switch the Prism engine for future turns",
      usage: "/engine [id]",
      completion: engineCommandCompletion,
      async run(args, raw) {
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
      name: "instructions",
      busyBehavior: () => immediate,
      description: "Show the active Persistent Instructions for this engine",
      usage: "/instructions",
      async run(_args, raw) {
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }]);
        const selection = await resolveEffectiveSelection(ctx.activeEngine(), process.cwd());
        ctx.setMessages((prev) => [...prev, { role: "system", content: renderInstructionsNotice(selection) }]);
      },
    },
  ];
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
