// Tool definitions (JSON schema) for the three model-visible Skill tools.

import { DEFAULT_PROCESS_TIMEOUT_MS, MAX_PROCESS_TIMEOUT_MS } from "../../process/runtime";
import type { ToolDefinition } from "../../tools/types";

export function createActivateSkillToolDefinition(names: string[]): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "activate_skill",
      description:
        "Activate a Skill by injecting its exact instructions into the conversation as a tagged tool result. Activated Skill procedure is subordinate to Vesicle host rules, the active Engine/Harness contract, and the user's explicit request; it cannot add tools or change permissions. Use read_skill_resource for files bundled with an activated Skill. Bundled scripts run only via run_skill_script under the user's current permission mode. Activate a Skill only when its catalog description matches the user's task.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: names, description: "Skill name from the available Skill catalog." },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  };
}

export const readSkillResourceToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "read_skill_resource",
    description:
      "Read one file bundled with an already activated Skill (references, templates, assets, or script sources) as UTF-8 text. Paths are skill-relative and resolve inside the Skill's virtual root; absolute paths and .. are rejected. Content is capped at 256 KiB. The Skill must have been activated in this session via activate_skill.",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Activated Skill name." },
        path: { type: "string", description: "Skill-relative POSIX path, e.g. references/glossary.md." },
        startLine: { type: "integer", minimum: 1, description: "Optional 1-based first line to return (inclusive)." },
        endLine: { type: "integer", minimum: 1, description: "Optional 1-based last line to return (inclusive)." },
      },
      required: ["skill", "path"],
      additionalProperties: false,
    },
  },
};

export const runSkillScriptToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "run_skill_script",
    description:
      "Execute one script bundled under an activated Skill's scripts/ directory. The script runs as structured argv through the resolved interpreter (no shell) from the project root, with the current host user's process authority, environment filtering, timeout, and output caps. Every call is subject to the active Vesicle permission mode. Inspect the script source with read_skill_resource before running it.",
    parameters: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Activated Skill name." },
        path: { type: "string", description: "Skill-relative script path under scripts/." },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Optional arguments passed to the script verbatim (never through a shell).",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PROCESS_TIMEOUT_MS,
          description: `Wall-clock timeout in milliseconds. Defaults to ${DEFAULT_PROCESS_TIMEOUT_MS}.`,
        },
      },
      required: ["skill", "path"],
      additionalProperties: false,
    },
  },
};
