// /permissions — tool approval mode show/set.

import { afterAgentLoop, immediate } from "./dispatch";
import { fixedCommandCompletion } from "./argument-completion";
import { permissionModes, type PermissionMode } from "../../core/permissions";
import type { Command, PermissionsCommandContext } from "./types";

export function createPermissionsCommands(ctx: PermissionsCommandContext): Command[] {
  return [
    {
      name: "permissions",
      busyBehavior: (args) => args ? afterAgentLoop : immediate,
      description: "Show or change the tool approval mode",
      usage: "/permissions [MANUAL|INERTIA|MOMENTUM|YOLO]",
      completion: fixedCommandCompletion("permissions"),
      async run(args, raw) {
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
  ];
}
