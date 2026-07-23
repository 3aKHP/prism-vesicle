import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { requireProjectHarnessRuntime, resolveProjectHarnessRuntime } from "../harness/activation";
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
};

export const INIT_PROMPT_LOGICAL_PATH = "assets/prompts/shared/init-project.md";

/**
 * `/init`: scan the project, make one no-tools provider call with the dedicated
 * host init prompt, and write a project-scope `VESICLE.md`. The file is written
 * host-side (outside the model-visible writable roots) and takes effect on the
 * next top-level turn, when Persistent Instructions re-resolve from disk. An
 * existing `VESICLE.md` is backed up under `.vesicle/init-backups/` before being
 * replaced, never silently overwritten.
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

  const content = response.content.trim();
  if (!content) throw new Error("The provider returned an empty response; VESICLE.md was not written.");

  return writeProjectInstructions(options.rootDir, content);
}

async function writeProjectInstructions(rootDir: string, content: string): Promise<GeneratedInstructions> {
  const target = join(rootDir, "VESICLE.md");
  const overwritten = existsSync(target);
  let backupPath: string | undefined;
  if (overwritten) {
    const backupDir = join(rootDir, ".vesicle", "init-backups");
    await mkdir(backupDir, { recursive: true });
    backupPath = join(backupDir, "VESICLE.md.previous");
    // Copy (not rename) so a failed write leaves the original in place.
    await copyFile(target, backupPath);
  }
  await writeFile(target, `${content}\n`, "utf8");
  return {
    path: "VESICLE.md",
    overwritten,
    ...(backupPath ? { backupPath: relativeBackupPath(backupPath, rootDir) } : {}),
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
