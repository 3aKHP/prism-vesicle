import { join } from "node:path";
import type { EngineProfile } from "../engine/profile";
import { resolveAssetsRoot } from "../runtime/assets";

export type { EngineId } from "../engine/profile";

export type PromptSection = {
  /** Project-relative path the section was loaded from. */
  path: string;
  text: string;
};

export type PromptBundle = {
  sections: PromptSection[];
};

/**
 * Load every prompt section declared on the engine profile, in declared
 * order. The composer concatenates them with a blank-line separator. This
 * keeps the profile's `systemPrompt: [...]` list as the single source of
 * truth for what the model sees — no prompt text is hardcoded in source.
 */
export async function loadPromptBundle(
  profile: EngineProfile,
  rootDir = process.cwd(),
): Promise<PromptBundle> {
  const assetRoot = resolveAssetsRoot(rootDir);
  const sections = await Promise.all(
    profile.systemPrompt.map(async (relativePath) => {
      const absolutePath = join(assetRoot, relativePath);
      const text = await readFileText(absolutePath);
      return { path: relativePath, text };
    }),
  );

  return { sections };
}

export function composeSystemPrompt(bundle: PromptBundle): string {
  return bundle.sections
    .map((section) => section.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}

async function readFileText(absolutePath: string): Promise<string> {
  // Bun.file keeps the runtime dependency surface tiny and matches the
  // existing session/prompt code shape.
  return Bun.file(absolutePath).text();
}
