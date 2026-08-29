// /help — static help text. The only context it reads is the transcript echo,
// so it owns no domain state beyond the text it prints.

import { immediate } from "./dispatch";
import type { Command, HelpCommandContext } from "./types";

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
  "  /branch           browse and switch candidate branches at any depth (Ctrl+B)",
  "  /btw <question>   ask a temporary side question without interrupting the turn",
  "  /skill            list available skills (no args = picker)",
  "  /skill <name> [task] activate a skill and optionally invoke it with a task",
  "  /skill <name> --context-only activate without starting a provider request",
  "  /resume           list sessions",
  "  /resume <n|id>    resume a session",
  "  /new              start a fresh session",
  "  /title            view title; /title rename <text>; /title regenerate",
  "  /help             show this help",
].join("\n");

export function createHelpCommands(ctx: HelpCommandContext): Command[] {
  return [
    {
      name: "help",
      busyBehavior: immediate,
      description: "Show available commands",
      completion: null,
      async run(_args, raw) {
        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: raw },
          { role: "system", content: HELP_TEXT },
        ]);
      },
    },
  ];
}
