// /websearch — provider-native built-in web search status and session override (#225).

import { immediate } from "./dispatch";
import { webSearchCommandCompletion } from "./argument-completion";
import type { Command, WebSearchCommandContext } from "./types";

const WEB_SEARCH_USAGE = "Usage: /websearch [on|off].\nToggles the model's provider-native web search for this session; default comes from the model entry.";

type WebSearchArgs =
  | { kind: "status" }
  | { kind: "override"; enabled: boolean }
  | { error: string };

/**
 * /websearch          status
 * /websearch on|off   session override (process-scoped; /new or resume reverts
 *                     to the model entry's webSearchDefault)
 * Extra or unknown operands are usage errors with no mutation.
 */
function parseWebSearchArgs(args: string): WebSearchArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "status" };
  if (tokens.length > 1) return { error: WEB_SEARCH_USAGE };
  const operand = tokens[0]!.toLowerCase();
  if (operand === "on") return { kind: "override", enabled: true };
  if (operand === "off") return { kind: "override", enabled: false };
  return { error: WEB_SEARCH_USAGE };
}

export function createWebSearchCommands(ctx: WebSearchCommandContext): Command[] {
  return [
    {
      name: "websearch",
      busyBehavior: immediate,
      description: "Show or toggle built-in web search",
      usage: "/websearch [on|off]",
      completion: webSearchCommandCompletion,
      async run(args, raw) {
        const parsed = parseWebSearchArgs(args);
        if ("error" in parsed) {
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: parsed.error }]);
          return;
        }
        if (parsed.kind === "status") {
          ctx.setMessages((prev) => [
            ...prev,
            { role: "user", content: raw },
            { role: "system", content: ctx.webSearch.statusText() },
          ]);
          return;
        }
        const notice = ctx.webSearch.applyOverride(parsed.enabled);
        ctx.setStatus(`web search ${parsed.enabled ? "on" : "off"}`);
        ctx.recordActivity({ kind: "system", text: `websearch ${parsed.enabled ? "on" : "off"}` });
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: notice }]);
      },
    },
  ];
}
