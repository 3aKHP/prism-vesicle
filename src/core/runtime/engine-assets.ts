import type { EngineId, EngineProfile } from "../engine/profile";
import { loadEngineProfile } from "../engine/profile";
import type { PromptBundle } from "../prompt/loader";
import { composeSystemPrompt, loadPromptBundle } from "../prompt/loader";
import { createAssetResolver, type AssetFingerprint, type AssetResolver, type AssetResolverOptions } from "./assets";

export type EngineAssetRuntime = {
  profile: EngineProfile;
  promptBundle: PromptBundle;
  systemPrompt: string;
  assets: AssetFingerprint;
};

/** Load one internally consistent profile/prompt view and its safe fingerprint. */
export async function loadEngineAssetRuntime(
  engine: EngineId,
  rootDir = process.cwd(),
  options: AssetResolverOptions & { resolver?: AssetResolver } = {},
): Promise<EngineAssetRuntime> {
  const resolver = options.resolver ?? createAssetResolver(rootDir, options);
  const profile = await loadEngineProfile(engine, rootDir, resolver);
  const promptBundle = await loadPromptBundle(profile, rootDir, resolver);
  // Sessions may let the model read any effective spec/template through the
  // guarded assets namespace, so drift covers the full merged tree rather
  // than only the profile and prompt files loaded at startup.
  const assets = await resolver.fingerprint(await resolver.listFiles("assets", true));
  return {
    profile,
    promptBundle,
    systemPrompt: composeSystemPrompt(promptBundle),
    assets,
  };
}

export function changedAssetPaths(
  previous: AssetFingerprint,
  current: AssetFingerprint,
): string[] {
  const oldHashes = new Map(previous.files.map((file) => [file.path, file.sha256]));
  const newHashes = new Map(current.files.map((file) => [file.path, file.sha256]));
  return [...new Set([...oldHashes.keys(), ...newHashes.keys()])]
    .filter((path) => oldHashes.get(path) !== newHashes.get(path))
    .sort();
}

export async function inspectEngineAssetDrift(
  previous: AssetFingerprint | undefined,
  engine: EngineId,
  rootDir = process.cwd(),
  options: AssetResolverOptions = {},
): Promise<{ current: AssetFingerprint; changedPaths: string[] } | undefined> {
  if (!previous) return undefined;
  const current = (await loadEngineAssetRuntime(engine, rootDir, options)).assets;
  if (current.sha256 === previous.sha256) return undefined;
  return { current, changedPaths: changedAssetPaths(previous, current) };
}
