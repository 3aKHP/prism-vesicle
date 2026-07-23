import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
 * existing `VESICLE.md` is backed up under `.vesicle/init-backups/` before being
 * replaced, never silently overwritten.
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

  const target = instructionFilePath({ scope: "project", engine: "all" }, options.rootDir);
  const maskedByEngineOverrides = detectProjectEngineOverrides(options.rootDir);
  return writeProjectInstructions(target, content, options.rootDir, maskedByEngineOverrides);
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
): Promise<GeneratedInstructions> {
  const overwritten = existsSync(target);
  let backupPath: string | undefined;
  let backupReplacedPrior = false;
  if (overwritten) {
    const backupDir = join(rootDir, ".vesicle", "init-backups");
    await mkdir(backupDir, { recursive: true });
    backupPath = join(backupDir, "VESICLE.md.previous");
    backupReplacedPrior = existsSync(backupPath);
    // Copy (not rename) so a failed write leaves the original in place.
    await copyFile(target, backupPath);
  }
  await writeFile(target, `${content}\n`, "utf8");
  return {
    path: "VESICLE.md",
    overwritten,
    ...(backupPath ? { backupPath: relativeBackupPath(backupPath, rootDir) } : {}),
    ...(backupReplacedPrior ? { backupReplacedPrior: true } : {}),
    ...(maskedByEngineOverrides.length ? { maskedByEngineOverrides } : {}),
  };
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
