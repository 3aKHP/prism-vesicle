import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { engineIds } from "../engine/profile";
import { requireProjectHarnessRuntime, resolveProjectHarnessRuntime } from "../harness/activation";
import { INSTRUCTION_COMBINED_BUDGET_BYTES, instructionFilePath, instructionLogicalName } from "../instructions";
import { scanProject } from "./scanner";

export type GenerateProjectInstructionsOptions = {
  rootDir: string;
  /** Explicitly allow replacing an existing project-scope VESICLE.md. */
  force?: boolean;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  notes?: string;
  signal?: AbortSignal;
};

export type GeneratedInstructions = {
  /** Project-relative target path that was written. */
  path: string;
  overwritten: boolean;
  /** Project-relative backup path when an existing file was replaced. */
  backupPath?: string;
  /** A prior `.previous` backup at the backup path was replaced by this run. */
  backupReplacedPrior?: boolean;
  /** Engine ids whose project-scope `VESICLE.<engine>.md` masks this general file. */
  maskedByEngineOverrides?: string[];
};

export const INIT_PROMPT_LOGICAL_PATH = "assets/prompts/shared/init-project.md";

/**
 * `/init`: scan the project, make one no-tools provider call with the dedicated
 * host init prompt, and write a project-scope `VESICLE.md`. The file is written
 * host-side (outside the model-visible writable roots) and takes effect on the
 * next top-level turn, when Persistent Instructions re-resolve from disk. An
 * existing `VESICLE.md` is refused unless `force` is explicit, then backed up
 * under `.vesicle/init-backups/` before being replaced.
 *
 * The path is resolved through the Persistent Instructions resolver so /init and
 * PI can never drift on the target filename. Provider output is sanitized (one
 * outer code fence stripped) so a mis-formatted response cannot pollute every
 * future session's system prompt, and the result is rejected if it would exceed
 * the Persistent Instruction budget (which would otherwise be silently dropped).
 */
export async function generateProjectInstructions(
  options: GenerateProjectInstructionsOptions,
): Promise<GeneratedInstructions> {
  const target = instructionFilePath({ scope: "project", engine: "all" }, options.rootDir);
  refuseExistingTarget(target, options.force === true);

  const config = await loadConfigForSelection(options.providerSelection);
  const provider = createProvider(config);
  const harness = requireProjectHarnessRuntime(await resolveProjectHarnessRuntime(options.rootDir));
  const initPrompt = await harness.assets.readText(INIT_PROMPT_LOGICAL_PATH);
  const digest = await scanProject(options.rootDir);
  const userContent = options.notes?.trim()
    ? `${digest}\n\nAdditional notes from the user:\n${options.notes.trim()}`
    : digest;

  const response = await complete(provider, {
    id: "vesicle-init",
    model: { provider: config.providerId, model: config.model },
    system: [initPrompt],
    messages: [{ role: "user", content: userContent }],
    generation: options.generation,
    signal: options.signal,
  });

  const content = formatInitContent(response.content);
  if (!content) throw new Error("The provider returned an empty response; VESICLE.md was not written.");

  const fileBytes = Buffer.byteLength(`${content}\n`, "utf8");
  if (fileBytes > INSTRUCTION_COMBINED_BUDGET_BYTES) {
    throw new Error(
      `The generated VESICLE.md is ${fileBytes} bytes, exceeding the ${INSTRUCTION_COMBINED_BUDGET_BYTES}-byte Persistent Instruction budget, so Persistent Instructions would not load it. The model was too verbose — re-run /init, or narrow the project scan or notes.`,
    );
  }

  const maskedByEngineOverrides = detectProjectEngineOverrides(options.rootDir);
  return writeProjectInstructions(target, content, options.rootDir, maskedByEngineOverrides, options.force === true);
}

function refuseExistingTarget(target: string, force: boolean): void {
  const targetInfo = lstatTarget(target);
  if (!targetInfo) return;
  if (!force) {
    throw new Error(
      "VESICLE.md already exists. Use /init --force to regenerate it; the current file will be backed up to .vesicle/init-backups/VESICLE.md.previous.",
    );
  }
  if (!targetInfo.isFile()) {
    throw new Error("VESICLE.md exists but is not a regular file. /init --force refuses linked or non-file targets.");
  }
}

function lstatTarget(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Trim and strip one outer ```lang ... ``` fence. Some providers wrap output in
 * a code fence despite the prompt instruction; since Persistent Instructions
 * inject this file verbatim into every future system prompt, an unstripped fence
 * would silently pollute every session. Mirrors compact's defensive formatter.
 */
function formatInitContent(content: string): string {
  const trimmed = content.trim();
  const lines = trimmed.split("\n");
  if (lines.length >= 2 && /^```[a-zA-Z0-9]*$/.test(lines[0]!) && lines[lines.length - 1]!.trim() === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }
  return trimmed;
}

function detectProjectEngineOverrides(rootDir: string): string[] {
  return engineIds.filter((engine) => existsSync(join(rootDir, instructionLogicalName(engine))));
}

async function writeProjectInstructions(
  target: string,
  content: string,
  rootDir: string,
  maskedByEngineOverrides: string[],
  force: boolean,
): Promise<GeneratedInstructions> {
  const overwritten = force && lstatTarget(target) !== null;
  let backupPath: string | undefined;
  let backupReplacedPrior = false;
  if (overwritten) {
    refuseExistingTarget(target, true);
    const backupDir = join(rootDir, ".vesicle", "init-backups");
    const previousContent = await readStableRegularFile(target);
    await ensureBackupDirectory(rootDir, backupDir);
    backupPath = join(backupDir, "VESICLE.md.previous");
    backupReplacedPrior = lstatTarget(backupPath) !== null;
    await atomicWrite(backupPath, previousContent);
  }
  try {
    if (force) {
      await atomicWrite(target, `${content}\n`);
    } else {
      await writeFile(target, `${content}\n`, { encoding: "utf8", flag: "wx" });
    }
  } catch (error) {
    if (!force && error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(
        "VESICLE.md was created while /init was generating its draft. Nothing was overwritten; review the current file, or use /init --force to replace it with a backup.",
      );
    }
    throw error;
  }
  return {
    path: "VESICLE.md",
    overwritten,
    ...(backupPath ? { backupPath: relativeBackupPath(backupPath, rootDir) } : {}),
    ...(backupReplacedPrior ? { backupReplacedPrior: true } : {}),
    ...(maskedByEngineOverrides.length ? { maskedByEngineOverrides } : {}),
  };
}

async function readStableRegularFile(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    const current = lstatTarget(path);
    if (!opened.isFile() || !current?.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("VESICLE.md changed or became linked while /init --force was preparing its backup; nothing was replaced.");
    }
    const content = await handle.readFile();
    const afterRead = lstatTarget(path);
    if (!afterRead?.isFile() || opened.dev !== afterRead.dev || opened.ino !== afterRead.ino) {
      throw new Error("VESICLE.md changed or became linked while /init --force was preparing its backup; nothing was replaced.");
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function ensureBackupDirectory(rootDir: string, backupDir: string): Promise<void> {
  const stateDir = join(rootDir, ".vesicle");
  for (const path of [stateDir, backupDir]) {
    const current = lstatTarget(path);
    if (current && !current.isDirectory()) {
      throw new Error("The /init backup directory is linked or is not a directory; refusing to write a backup.");
    }
    if (!current) await mkdir(path);
  }
}

async function atomicWrite(path: string, content: string | Uint8Array): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { flag: "wx", mode: 0o644 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function relativeBackupPath(absoluteBackupPath: string, rootDir: string): string {
  return absoluteBackupPath.slice(rootDir.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
}

async function complete(provider: ReturnType<typeof createProvider>, request: VesicleRequest): Promise<VesicleResponse> {
  if (!provider.stream) return provider.complete(request);
  let response: VesicleResponse | undefined;
  for await (const event of provider.stream(request)) {
    if (event.type === "complete") response = event.response;
  }
  if (!response) throw new Error("Provider stream ended without a final response.");
  return response;
}
