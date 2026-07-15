import type { EngineProfile } from "../engine/profile";
import { createAssetResolver, type AssetResolver, type AssetSource } from "../runtime/assets";

export type { EngineId } from "../engine/profile";

export type PromptSection = {
  /** Project-relative path the section was loaded from. */
  path: string;
  text: string;
  source: AssetSource;
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
  assets: AssetResolver = createAssetResolver(rootDir),
): Promise<PromptBundle> {
  const sections = await Promise.all(
    profile.systemPrompt.map(async (relativePath) => {
      const resolved = await assets.resolveFile(relativePath);
      const text = await assets.readText(resolved.logicalPath);
      return { path: resolved.logicalPath, text, source: resolved.source };
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
