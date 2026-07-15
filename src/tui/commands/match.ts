// Substring command matching for the slash-command popup. Pure and unit-tested
// so it can be swapped for a fuzzy matcher later without touching callers —
// matchCommands is the single seam between "what the user typed after /" and
// "which commands the popup shows".
//
// Ranking (lower score = shown first):
//   0  exact name          "/model"      -> model
//   1  name prefix          "mo"         -> model, models…
//   2  alias prefix         "alt"        -> a command with alias "alternate"
//   3  name substring       "ode"        -> model
//   4  alias substring      "ork"        -> engine
//   5  description substring "switch"    -> commands whose description matches
//  -1  no match             (excluded)
//
// An empty query returns every command in declaration order (the popup opens
// showing the full list, then narrows as the user types).

import type { Command } from "./types";

export function matchCommands(query: string, commands: readonly Command[]): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const ranked: Array<{ cmd: Command; score: number }> = [];
  for (const cmd of commands) {
    const score = scoreCommand(q, cmd);
    if (score >= 0) ranked.push({ cmd, score });
  }
  ranked.sort((a, b) => (a.score !== b.score ? a.score - b.score : commands.indexOf(a.cmd) - commands.indexOf(b.cmd)));
  return ranked.map((r) => r.cmd);
}

function scoreCommand(q: string, cmd: Command): number {
  const name = cmd.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (cmd.aliases?.some((a) => a.toLowerCase().startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  if (cmd.aliases?.some((a) => a.toLowerCase().includes(q))) return 4;
  if (cmd.description.toLowerCase().includes(q)) return 5;
  return -1;
}
