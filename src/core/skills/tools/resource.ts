// read_skill_resource executor: reads a bundled file from a previously
// activated Skill as UTF-8 text with path hardening and a 256 KiB cap. Does not
// import interpreter or process — resource reading is pure file I/O.

import { readFile } from "node:fs/promises";
import { MAX_TEXT_REFERENCE_BYTES, utf8SafeBoundary } from "../../../skills/paths";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { SkillToolEvent } from "../types";
import { requireRuntime, requireActivatedSkill, resolveSkillFile, fail } from "./activated-skill";
import type { SkillToolRuntimeOptions } from "./activated-skill";
import { parseArgs, parseLineRange } from "./arguments";

export async function executeReadSkillResourceTool(call: ToolCall, options: SkillToolRuntimeOptions): Promise<ToolResult> {
  const unavailable = requireRuntime(call, options);
  if (unavailable) return unavailable;
  const args = parseArgs(call, ["skill", "path"], ["startLine", "endLine"]);
  if ("error" in args) return fail(call, (args as { error: string }).error);
  const name = args.skill as string;
  const relPath = args.path as string;
  const lineRange = parseLineRange(call, args);
  if (lineRange.error) return fail(call, lineRange.error);

  const resolved = await requireActivatedSkill(call, options, name);
  if ("result" in resolved) return resolved.result;
  const skill = resolved.skill;
  const file = await resolveSkillFile(skill, relPath);
  if ("error" in file) return fail(call, file.error);

  const raw = await readFile(file.absolutePath).catch((error: unknown) => {
    // Node error messages embed the absolute host path; never surface it.
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "read error";
    throw new Error(`Skill resource "${relPath}" could not be read (${code}).`);
  });
  const capped = raw.byteLength > MAX_TEXT_REFERENCE_BYTES;
  const kept = capped ? raw.subarray(0, utf8SafeBoundary(raw, MAX_TEXT_REFERENCE_BYTES)) : raw;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(kept);
  } catch {
    return fail(
      call,
      `Skill resource "${relPath}" is not valid UTF-8 text and cannot be read as a text resource. Binary assets are disclosed by activate_skill but are not readable through this tool.`,
    );
  }
  const lines = text.split("\n");
  const start = lineRange.startLine ?? 1;
  const end = lineRange.endLine ?? lines.length;
  const sliced = lines.slice(start - 1, end).join("\n");
  const notes: string[] = [];
  if (capped) notes.push(`[truncated: resource exceeds the ${MAX_TEXT_REFERENCE_BYTES}-byte text limit; only the first part is shown]`);
  if (start > 1 || end < lines.length) notes.push(`[lines ${start}-${Math.min(end, lines.length)} of ${lines.length}]`);

  const event: SkillToolEvent = { kind: "skill_resource_read", name: skill.name, path: relPath, bytes: raw.byteLength, truncated: capped };
  const body = `[skill_resource name="${skill.name}" path="${relPath}"]\n${sliced}${notes.length > 0 ? `\n${notes.join("\n")}` : ""}`;
  return { callId: call.id, name: call.name, ok: true, content: body, skillEvent: event };
}
