// /theme — colour theme status, session override, and project persistence (#86).

import { immediate } from "./dispatch";
import { themeCommandCompletion } from "./argument-completion";
import { type ThemePreference } from "../theme";
import type { Command, ThemeCommandContext } from "./types";

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

export function createThemeCommands(ctx: ThemeCommandContext): Command[] {
  return [
    {
      name: "theme",
      busyBehavior: immediate,
      description: "Show or set the colour theme",
      usage: "/theme [dark|light|default|auto] [--persist] [--unset-project]",
      completion: themeCommandCompletion,
      async run(args, raw) {
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
  ];
}
