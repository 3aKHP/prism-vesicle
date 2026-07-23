import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { instructionFilePath } from "./paths";
import type { InstructionDiagnostic, InstructionDiagnosticKind, InstructionTarget, LoadedInstructionFile } from "./types";

/** The three outcomes of loading one exact target. Absent is normal and silent. */
export type TargetLoadResult =
  | { kind: "absent" }
  | { kind: "file"; file: LoadedInstructionFile }
  | { kind: "invalid"; diagnostic: InstructionDiagnostic };

/** Combined budget for the selected user + project content for one Engine. */
export const INSTRUCTION_COMBINED_BUDGET_BYTES = 32 * 1024;

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * Read and validate one exact instruction target.
 *
 * Validation is fail-soft per scope: an invalid target reports `invalid`
 * (carrying a diagnostic) so the caller skips that scope and suppresses general
 * fallback within it, but this function never throws. Absent targets are
 * `absent` (silent).
 *
 * Symlink policy differs by scope: a project target that is itself a link, or a
 * user-scope link, is rejected with a diagnostic in M1 (a repository-controlled
 * link could redirect a fixed target to arbitrary host state). A host-level
 * symlink that merely reaches the launch root or user-config root is not
 * rejected; only the fixed target file itself is checked here.
 */
export async function loadInstructionTarget(
  target: InstructionTarget,
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TargetLoadResult> {
  const path = instructionFilePath(target, rootDir, env);
  const logicalName = basename(path);

  let linkStats: Awaited<ReturnType<typeof lstat>>;
  try {
    linkStats = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return { kind: "absent" };
    return invalid(target, logicalName, "read-error", readErrorMessage(error));
  }

  if (linkStats.isSymbolicLink()) {
    const kind: InstructionDiagnosticKind = target.scope === "project" ? "linked-project-target" : "linked-user-target";
    return invalid(target, logicalName, kind, `${logicalName} is a symbolic link; skipped to protect host filesystem authority.`);
  }
  if (!linkStats.isFile()) {
    return invalid(target, logicalName, "not-a-regular-file", `${logicalName} is not a regular file.`);
  }

  let raw: Uint8Array;
  try {
    raw = await readFile(path);
  } catch (error) {
    return invalid(target, logicalName, "read-error", readErrorMessage(error));
  }
  // Confirm the resolved entry is still a regular file (no race to a directory/link).
  try {
    const followed = await stat(path);
    if (!followed.isFile()) {
      return invalid(target, logicalName, "not-a-regular-file", `${logicalName} resolved to a non-regular file.`);
    }
  } catch (error) {
    return invalid(target, logicalName, "read-error", readErrorMessage(error));
  }

  const bomStripped = raw.length >= 3 && raw[0] === UTF8_BOM[0] && raw[1] === UTF8_BOM[1] && raw[2] === UTF8_BOM[2]
    ? raw.subarray(3)
    : raw;

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bomStripped);
  } catch {
    return invalid(target, logicalName, "invalid-utf8", `${logicalName} is not valid UTF-8.`);
  }

  const sha256 = createHash("sha256").update(content).digest("hex");
  const bytes = Buffer.byteLength(content, "utf8");
  const empty = content.trim().length === 0;

  return {
    kind: "file",
    file: { target, logicalName, content, sha256, bytes, empty },
  };
}

function invalid(
  target: InstructionTarget,
  logicalName: string,
  kind: InstructionDiagnosticKind,
  message: string,
): TargetLoadResult {
  return { kind: "invalid", diagnostic: { scope: target.scope, engine: target.engine, logicalName, kind, message } };
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function readErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "unknown read error";
}
