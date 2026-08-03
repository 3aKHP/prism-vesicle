// /workspace, /artifact, /validate — Workspace page navigation and artifact
// preview/validation. Grouped because they share the workspace-target and
// artifact-preview ports.

import { afterToolRound, immediate, resolveArtifactTarget } from "./dispatch";
import { artifactCommandCompletion } from "./argument-completion";
import { renderValidationNotice } from "./render";
import type { Command, WorkspaceCommandContext } from "./types";

export function createWorkspaceCommands(ctx: WorkspaceCommandContext): Command[] {
  return [
    {
      name: "workspace",
      busyBehavior: immediate,
      description: "Open the Workspace page, optionally locating a file or directory",
      usage: "/workspace [path]",
      async run(args, raw) {
        const located = await ctx.openWorkspaceTarget(args.trim() || undefined);
        ctx.setStatus("workspace page");
        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: raw },
          {
            role: "system",
            content: args.trim()
              ? located
                ? `Opened ${args.trim()} in the Workspace page.`
                : `Workspace page open — "${args.trim()}" was not found in the project.`
              : "Workspace page open. Ctrl+O switches pages, Ctrl+P quick open, F6 cycles regions.",
          },
        ]);
      },
    },

    {
      name: "artifact",
      busyBehavior: afterToolRound,
      description: "Open artifacts in the Workspace page (no args = latest)",
      usage: "/artifact [n|path]",
      completion: artifactCommandCompletion("artifact"),
      async run(args, raw) {
        const entries = await ctx.refreshArtifacts();
        if (!args) {
          const latest = entries[0];
          await ctx.openWorkspaceTarget(latest?.path);
          ctx.setMessages((prev) => [
            ...prev,
            { role: "user", content: raw },
            {
              role: "system",
              content: latest
                ? `Opened latest artifact ${latest.path} in the Workspace page.`
                : "Workspace page open — no artifacts yet.",
            },
          ]);
          return;
        }
        const artifact = resolveArtifactTarget(entries, args);
        if (!artifact) {
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: `No artifact matches "${args}". Use /artifact to open the latest.` }]);
          return;
        }
        await ctx.openWorkspaceTarget(artifact.path);
        ctx.setMessages((prev) => [
          ...prev,
          { role: "user", content: raw },
          { role: "system", content: `Opened ${artifact.path} in the Workspace page.` },
        ]);
      },
    },

    {
      name: "validate",
      busyBehavior: afterToolRound,
      description: "Validate an artifact file",
      usage: "/validate <n|path>",
      completion: artifactCommandCompletion("validate"),
      async run(args, raw) {
        const entries = await ctx.refreshArtifacts();
        const artifact = resolveArtifactTarget(entries, args);
        if (!artifact) {
          ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: `No artifact matches "${args || "(empty)"}". Use /artifact to list.` }]);
          return;
        }
        const selected = await ctx.loadArtifactPreview(artifact, { validate: true });
        ctx.setSelectedArtifact(selected);
        ctx.setMessages((prev) => [...prev, { role: "user", content: raw }, { role: "system", content: renderValidationNotice(selected.validation) }]);
      },
    },
  ];
}
