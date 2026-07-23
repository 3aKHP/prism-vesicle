import { join } from "node:path";
import { userConfigDirectory } from "../../config/paths";
import type { InstructionEngine, InstructionScope, InstructionTarget } from "./types";

/**
 * Canonical instruction filename, aligned across both scopes:
 * `VESICLE.md` for the general target and `VESICLE.<engine>.md` for an
 * Engine-specific override. The name is Vesicle-native (the analog of a coding
 * agent's `CLAUDE.md`/`AGENTS.md`) and is the only name the host resolves; no
 * alternate, nested, or legacy names are searched.
 */
export const INSTRUCTION_FILE_BASE = "VESICLE";

export function instructionLogicalName(engine: InstructionEngine): string {
  return engine === "all" ? `${INSTRUCTION_FILE_BASE}.md` : `${INSTRUCTION_FILE_BASE}.${engine}.md`;
}

/**
 * Absolute path for one exact target. User scope lives in the Vesicle user
 * configuration directory (beside `providers.yaml`), so it is portable across
 * project roots; project scope lives at the launch project root. Both are
 * outside the guarded `assets/` namespace and the writable artifact roots.
 */
export function instructionFilePath(
  target: InstructionTarget,
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const name = instructionLogicalName(target.engine);
  return target.scope === "user" ? join(userConfigDirectory(env), name) : join(rootDir, name);
}

export function instructionScopeDirectory(
  scope: InstructionScope,
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return scope === "user" ? userConfigDirectory(env) : rootDir;
}
