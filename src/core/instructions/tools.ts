import type { EngineId } from "../engine/profile";
import { engineIds } from "../engine/profile";
import { composeInstructionBlocks, resolveEffectiveSelection } from "./compose";
import { freezeInstructionBlocks } from "./instruction-context";
import { loadInstructionTarget } from "./loader";
import { instructionLogicalName } from "./paths";
import { InstructionUpdateError, updateInstructionTarget } from "./store";
import type { InstructionTarget, InstructionToolEvent } from "./types";
import type { ToolCall, ToolDefinition, ToolResult } from "../tools/types";

/**
 * Model-visible Persistent Instruction tools. `read_instructions` is an
 * observation (any target, including ones not selected for the active Engine);
 * `update_instructions` writes or deletes one exact `{ scope, engine }` target
 * through the instruction store (atomic write, optimistic concurrency, backup,
 * budget). Both are universal host controls for non-Stage Engines, available for
 * explicit user-requested persistent workflow management — never autonomous
 * self-modification.
 */

export type InstructionToolOptions = {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
  /** Active Engine, used to report `selectedForActiveEngine` and refresh the frozen snapshot. */
  activeEngine?: EngineId;
  /** Session id, used to refresh the in-turn frozen instruction snapshot after an update. */
  sessionId?: string;
};

const SCOPE_ENUM = ["user", "project"];
const ENGINE_ENUM = ["all", ...engineIds];

export const readInstructionsToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "read_instructions",
    description:
      "Read one Persistent Instruction target (VESICLE.md or VESICLE.<engine>.md at the project root, or the same names beside the user provider config). Use scope=user|project and engine=all|<engine>. Returns the content, size, and hash, and whether it is selected for the active Engine. An absent target returns exists=false. Use this for explicit, user-requested persistent workflow management — not for ordinary play.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: SCOPE_ENUM },
        engine: { type: "string", enum: ENGINE_ENUM },
      },
      required: ["scope", "engine"],
      additionalProperties: false,
    },
  },
};

export const updateInstructionsToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "update_instructions",
    description:
      "Write or delete one Persistent Instruction target (scope=user|project, engine=all|<engine>). Replaces or removes the whole target file; an empty content string is an explicit empty override. Optional ifMatchSha256 ('absent' or a 64-hex hash) guards concurrent edits; omit it for an intentional overwrite. The summary is a one-line human reason. Use this only for explicit, user-requested persistent workflow management — not to change host capabilities or modify ordinary play.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: SCOPE_ENUM },
        engine: { type: "string", enum: ENGINE_ENUM },
        action: { type: "string", enum: ["write", "delete"] },
        content: { type: "string", description: "Required for write; forbidden for delete." },
        ifMatchSha256: { type: "string", pattern: "^(absent|[a-f0-9]{64})$" },
        summary: { type: "string", minLength: 1, maxLength: 160 },
      },
      required: ["scope", "engine", "action", "summary"],
      additionalProperties: false,
    },
  },
};

export const instructionToolDefinitions: ToolDefinition[] = [
  readInstructionsToolDefinition,
  updateInstructionsToolDefinition,
];

export async function executeReadInstructionsTool(call: ToolCall, options: InstructionToolOptions): Promise<ToolResult> {
  const args = parseTargetArgs(call);
  if ("error" in args) return failure(call, args.error);
  const env = options.env ?? process.env;
  const target = { scope: args.scope, engine: args.engine };
  const load = await loadInstructionTarget(target, options.rootDir, env);
  const logicalName = instructionLogicalName(target.engine);
  const selectedForActiveEngine = await isSelectedForActiveEngine(target, options, env);

  if (load.kind === "file") {
    const event: InstructionToolEvent = {
      kind: "instruction",
      operation: "read",
      target,
      logicalName,
      beforeSha256: load.file.sha256,
      afterSha256: load.file.sha256,
      bytes: load.file.bytes,
      affectedEngines: [],
    };
    return {
      callId: call.id,
      name: call.name,
      ok: true,
      content: `Read ${logicalName} [${target.scope}] — ${load.file.bytes} bytes (sha256 ${load.file.sha256.slice(0, 8)}), selectedForActiveEngine=${selectedForActiveEngine}.${load.file.empty ? " (empty override)" : ""}\n\n${load.file.content}`,
      instructionEvent: event,
    };
  }

  const event: InstructionToolEvent = {
    kind: "instruction",
    operation: "read",
    target,
    logicalName,
    beforeSha256: null,
    afterSha256: null,
    bytes: 0,
    affectedEngines: [],
  };
  return {
    callId: call.id,
    name: call.name,
    ok: true,
    content: `${logicalName} [${target.scope}] does not exist (selectedForActiveEngine=${selectedForActiveEngine}).`,
    instructionEvent: event,
  };
}

export async function executeUpdateInstructionsTool(call: ToolCall, options: InstructionToolOptions): Promise<ToolResult> {
  const args = parseUpdateArgs(call);
  if ("error" in args) return failure(call, args.error);
  const env = options.env ?? process.env;
  const target: InstructionTarget = { scope: args.scope, engine: args.engine };

  try {
    const outcome = await updateInstructionTarget(target, args.action, args.content, args.ifMatchSha256, options.rootDir, env);
    // §8.4: a successful update is the only mid-turn reason to recompose. Refresh
    // the in-turn frozen snapshot so the next provider round sees the new content.
    if (outcome.changed && options.activeEngine && options.sessionId) {
      const selection = await resolveEffectiveSelection(options.activeEngine, options.rootDir, env);
      freezeInstructionBlocks(options.sessionId, composeInstructionBlocks(selection));
    }
    const affected = outcome.event.affectedEngines.length > 0 ? ` Affects: ${outcome.event.affectedEngines.join(", ")}.` : "";
    return {
      callId: call.id,
      name: call.name,
      ok: true,
      content: `${args.action === "write" ? "Wrote" : "Deleted"} ${outcome.event.logicalName} [${target.scope}] — ${outcome.changed ? "applied" : "no change (already absent)"}${outcome.event.afterSha256 ? ` (sha256 ${outcome.event.afterSha256.slice(0, 8)}, ${outcome.event.bytes} bytes)` : ""}.${affected} It takes effect on the next provider round.`,
      instructionEvent: outcome.event,
    };
  } catch (error) {
    if (error instanceof InstructionUpdateError) {
      const current = error.currentSha256 ? ` Current sha256: ${error.currentSha256.slice(0, 8)}.` : error.code === "cas_mismatch" ? " Current target is absent." : "";
      return failure(call, `update_instructions ${error.code}: ${error.message}${current}`);
    }
    throw error;
  }
}

async function isSelectedForActiveEngine(
  target: InstructionTarget,
  options: InstructionToolOptions,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (!options.activeEngine) return false;
  const selection = await resolveEffectiveSelection(options.activeEngine, options.rootDir, env);
  const selected = target.scope === "user" ? selection.user : selection.project;
  return selected?.target.engine === target.engine;
}

type TargetArgs = { scope: "user" | "project"; engine: EngineId | "all" } | { error: string };

function parseTargetArgs(call: ToolCall): TargetArgs {
  let parsed: { scope?: unknown; engine?: unknown };
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    return { error: "Malformed JSON arguments." };
  }
  if (parsed.scope !== "user" && parsed.scope !== "project") return { error: "scope must be 'user' or 'project'." };
  if (!isInstructionEngine(parsed.engine)) return { error: `engine must be one of: ${ENGINE_ENUM.join(", ")}.` };
  return { scope: parsed.scope, engine: parsed.engine };
}

function parseUpdateArgs(call: ToolCall): { scope: "user" | "project"; engine: EngineId | "all"; action: "write" | "delete"; content?: string; ifMatchSha256?: string } | { error: string } {
  const base = parseTargetArgs(call);
  if ("error" in base) return base;
  let parsed: { action?: unknown; content?: unknown; ifMatchSha256?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(call.arguments);
  } catch {
    return { error: "Malformed JSON arguments." };
  }
  if (parsed.action !== "write" && parsed.action !== "delete") return { error: "action must be 'write' or 'delete'." };
  if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0 || parsed.summary.length > 160) {
    return { error: "summary must be a 1–160 character string." };
  }
  let content: string | undefined;
  if (parsed.action === "write") {
    if (typeof parsed.content !== "string") return { error: "content (string) is required for write." };
    content = parsed.content;
  } else if (parsed.content !== undefined) {
    return { error: "content must be omitted for delete." };
  }
  let ifMatchSha256: string | undefined;
  if (parsed.ifMatchSha256 !== undefined) {
    if (typeof parsed.ifMatchSha256 !== "string" || !/^(absent|[a-f0-9]{64})$/.test(parsed.ifMatchSha256)) {
      return { error: "ifMatchSha256 must be 'absent' or 64 lowercase hex characters." };
    }
    ifMatchSha256 = parsed.ifMatchSha256;
  }
  return { scope: base.scope, engine: base.engine, action: parsed.action, content, ifMatchSha256 };
}

function isInstructionEngine(value: unknown): value is EngineId | "all" {
  return value === "all" || (typeof value === "string" && (engineIds as readonly string[]).includes(value));
}

function failure(call: ToolCall, message: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content: message };
}
