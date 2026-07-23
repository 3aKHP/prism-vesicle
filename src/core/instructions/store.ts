import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { userConfigDirectory } from "../../config/paths";
import { engineIds, type EngineId } from "../engine/profile";
import { resolveEffectiveSelection } from "./compose";
import { INSTRUCTION_COMBINED_BUDGET_BYTES, loadInstructionTarget } from "./loader";
import { instructionFilePath } from "./paths";
import type { InstructionBackupState, InstructionTarget, InstructionToolEvent } from "./types";

/**
 * Mutation side of the instruction tools: atomic write/delete with optimistic
 * concurrency, a single recoverable previous-state backup, and a pre-write
 * budget check that spans every engine the change affects. Targets are the same
 * fixed `{ scope, engine }` enum the loader uses — no arbitrary path is ever
 * accepted. Files live outside the model-visible writable roots, so this store
 * is the explicit, bounded exception that lets the model manage VESICLE.md.
 */

export type InstructionUpdateOutcome = {
  event: InstructionToolEvent;
  changed: boolean;
};

export class InstructionUpdateError extends Error {
  constructor(
    public readonly code: "cas_mismatch" | "oversized" | "invalid_argument" | "unsupported_target",
    message: string,
    public readonly currentSha256: string | null = null,
  ) {
    super(message);
    this.name = "InstructionUpdateError";
  }
}

export async function updateInstructionTarget(
  target: InstructionTarget,
  action: "write" | "delete",
  content: string | undefined,
  ifMatchSha256: string | undefined,
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstructionUpdateOutcome> {
  if (action === "write" && content === undefined) {
    throw new InstructionUpdateError("invalid_argument", "update_instructions write requires content.");
  }
  if (action === "delete" && content !== undefined) {
    throw new InstructionUpdateError("invalid_argument", "update_instructions delete must not include content.");
  }

  const path = instructionFilePath(target, rootDir, env);
  const logicalName = basename(path);

  await rejectLinkedTarget(path, target);

  const current = await loadInstructionTarget(target, rootDir, env);
  if (current.kind === "invalid") {
    throw new InstructionUpdateError(
      "unsupported_target",
      `${logicalName} exists but is not a valid instruction file; fix or remove it outside Vesicle before updating it.`,
    );
  }
  const beforeSha256 = current.kind === "file" ? current.file.sha256 : null;
  const beforeBytes = current.kind === "file" ? current.file.bytes : 0;
  const currentFile = current.kind === "file" ? current.file : null;
  const exists = currentFile !== null;

  // Optimistic concurrency: "absent" requires absence; any other value must
  // match the current normalized hash. A stale value never overwrites.
  if (ifMatchSha256 !== undefined) {
    if (ifMatchSha256 === "absent") {
      if (exists) throw new InstructionUpdateError("cas_mismatch", "Target already exists.", beforeSha256);
    } else if (!exists || beforeSha256 !== ifMatchSha256) {
      throw new InstructionUpdateError("cas_mismatch", "Supplied hash does not match the current target.", beforeSha256);
    }
  }

  // Delete of an already-absent target (with no contradicting CAS) is a success no-op.
  if (action === "delete" && !exists) {
    return {
      changed: false,
      event: {
        kind: "instruction",
        operation: "delete",
        target,
        logicalName,
        beforeSha256: null,
        afterSha256: null,
        bytes: 0,
        affectedEngines: [],
      },
    };
  }

  if (action === "write") {
    const newBytes = Buffer.byteLength(`${content}\n`, "utf8");
    if (newBytes > INSTRUCTION_COMBINED_BUDGET_BYTES) {
      throw new InstructionUpdateError(
        "oversized",
        `Content (${newBytes} bytes) alone exceeds the ${INSTRUCTION_COMBINED_BUDGET_BYTES}-byte instruction budget.`,
      );
    }
    await validateWriteCombination(target, newBytes, rootDir, env);
  } else {
    await validateDeleteCombination(target, rootDir, env);
  }

  const affectedEngines = await affectedEnginesForTarget(target, rootDir, env);

  // Capture the recoverable previous state before mutating. Aborting the
  // mutation if backup creation fails guarantees a restorable prior version.
  if (currentFile) {
    await backupPreviousState(target, path, currentFile.sha256, currentFile.bytes, rootDir, env);
  } else if (target.scope === "user") {
    await mkdir(userConfigDirectory(env), { recursive: true });
  }

  if (action === "write") {
    await atomicWrite(path, `${content}\n`, target.scope);
  } else {
    await unlink(path);
  }

  const writtenContent = action === "write" ? `${content}\n` : "";
  return {
    changed: true,
    event: {
      kind: "instruction",
      operation: action,
      target,
      logicalName,
      beforeSha256,
      afterSha256: action === "write" ? hashContent(writtenContent) : null,
      bytes: action === "delete" ? beforeBytes : Buffer.byteLength(writtenContent, "utf8"),
      affectedEngines,
    },
  };
}

async function rejectLinkedTarget(path: string, target: InstructionTarget): Promise<void> {
  const info = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (info?.isSymbolicLink()) {
    throw new InstructionUpdateError(
      "unsupported_target",
      `${target.scope} instruction target is a symbolic link; refusing to follow it.`,
    );
  }
}

/** Engines whose effective selection includes the target (and so change with it). */
async function affectedEnginesForTarget(
  target: InstructionTarget,
  rootDir: string,
  env: NodeJS.ProcessEnv,
): Promise<EngineId[]> {
  if (target.engine !== "all") return [target.engine];
  const affected: EngineId[] = [];
  for (const engine of engineIds) {
    const override = await loadInstructionTarget({ scope: target.scope, engine }, rootDir, env);
    if (override.kind !== "file") affected.push(engine);
  }
  return affected;
}

async function validateWriteCombination(
  target: InstructionTarget,
  newBytes: number,
  rootDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const engine of await affectedEnginesForTarget(target, rootDir, env)) {
    const selection = await resolveEffectiveSelection(engine, rootDir, env);
    const otherBytes = target.scope === "user" ? (selection.project?.bytes ?? 0) : (selection.user?.bytes ?? 0);
    if (newBytes + otherBytes > INSTRUCTION_COMBINED_BUDGET_BYTES) {
      throw new InstructionUpdateError(
        "oversized",
        `Writing this target would make engine "${engine}" instruction combination ${newBytes + otherBytes} bytes (limit ${INSTRUCTION_COMBINED_BUDGET_BYTES}).`,
      );
    }
  }
}

async function validateDeleteCombination(
  target: InstructionTarget,
  rootDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // Deleting the general target only shrinks combinations. Only deleting an
  // engine-specific override can activate an oversized general fallback.
  if (target.engine === "all") return;
  const engine = target.engine;
  const selection = await resolveEffectiveSelection(engine, rootDir, env);
  const otherBytes = target.scope === "user" ? (selection.project?.bytes ?? 0) : (selection.user?.bytes ?? 0);
  const fallback = await loadInstructionTarget({ scope: target.scope, engine: "all" }, rootDir, env);
  const fallbackBytes = fallback.kind === "file" ? fallback.file.bytes : 0;
  if (fallbackBytes + otherBytes > INSTRUCTION_COMBINED_BUDGET_BYTES) {
    throw new InstructionUpdateError(
      "oversized",
      `Deleting this override would activate a ${fallbackBytes + otherBytes}-byte combination for engine "${engine}" (limit ${INSTRUCTION_COMBINED_BUDGET_BYTES}).`,
    );
  }
}

async function backupPreviousState(
  target: InstructionTarget,
  path: string,
  sha256: string,
  bytes: number,
  rootDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const backupDir = instructionBackupDir(target.scope, rootDir, env);
  await mkdir(backupDir, { recursive: true });
  const priorState: InstructionBackupState = bytes === 0 ? "empty" : "content";
  const payloadName = backupPayloadName(target);
  const payloadPath = join(backupDir, `${payloadName}.previous`);
  const metaPath = join(backupDir, `${payloadName}.previous.json`);
  const content = await readFile(path, "utf8");
  // Payload first (temp + rename), then metadata, so the metadata is only valid
  // once its matching payload is in place.
  await atomicWrite(payloadPath, content, target.scope);
  await atomicWrite(metaPath, JSON.stringify({ target, priorState, sha256, bytes }), target.scope);
}

function instructionBackupDir(scope: InstructionTarget["scope"], rootDir: string, env: NodeJS.ProcessEnv): string {
  return scope === "user"
    ? join(userConfigDirectory(env), "instruction-backups")
    : join(rootDir, ".vesicle", "instruction-backups");
}

function backupPayloadName(target: InstructionTarget): string {
  const logical = target.engine === "all" ? "VESICLE.md" : `VESICLE.${target.engine}.md`;
  return `${target.scope}-${logical}`;
}

async function atomicWrite(path: string, content: string, scope: InstructionTarget["scope"]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = scope === "user" ? 0o600 : 0o644;
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
