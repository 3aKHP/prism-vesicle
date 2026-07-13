import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { VesicleRequest } from "../../providers/shared/types";
import type { EngineId } from "../engine/profile";
import { defaultPermissionRuntime } from "../permissions";
import type { PermissionRuntimeOptions } from "../permissions";
import { createSessionStore, loadSessionSnapshot } from "../session/store";
import { changedAssetPaths, loadEngineAssetRuntime } from "../runtime/engine-assets";
import type { AssetFingerprint } from "../runtime/assets";
import { mergeGeneration } from "./generation";
import type { AgentLoopEvent } from "./types";
import { resolveToolSurface } from "./tool-surface";

export type ContinuationContextOptions = {
  engine: EngineId;
  rootDir?: string;
  sessionId: string;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  permission?: PermissionRuntimeOptions;
  onEvent?: (event: AgentLoopEvent) => void;
};

export async function loadContinuationContext(
  options: ContinuationContextOptions,
  behavior: { emitAssetDrift?: boolean } = {},
) {
  const rootDir = options.rootDir ?? process.cwd();
  const permission = options.permission ?? defaultPermissionRuntime;
  const config = await loadConfigForSelection(options.providerSelection);
  const generation = mergeGeneration(config.generation, options.generation);
  const provider = createProvider(config);
  const engineAssets = await loadEngineAssetRuntime(options.engine, rootDir);
  const { profile, systemPrompt } = engineAssets;
  if (behavior.emitAssetDrift !== false) {
    await emitAssetDriftIfNeeded(rootDir, options.sessionId, engineAssets.assets, options.onEvent);
  }
  const toolSurface = await resolveToolSurface(
    profile,
    config.capabilities?.vision === true,
    permission.shellExecEnabled === true || permission.dangerouslySkipPermissions === true,
  );
  const session = await createSessionStore(rootDir, options.sessionId);
  return {
    rootDir,
    permission,
    config,
    generation,
    provider,
    profile,
    systemPrompt,
    toolSurface,
    session,
  };
}

export async function emitAssetDriftIfNeeded(
  rootDir: string,
  sessionId: string,
  current: AssetFingerprint,
  onEvent?: (event: AgentLoopEvent) => void,
): Promise<void> {
  if (!onEvent) return;
  const snapshot = await loadSessionSnapshot(rootDir, sessionId, {
    synthesizeDanglingToolResults: false,
  });
  if (!snapshot.assets || snapshot.assets.sha256 === current.sha256) return;
  onEvent({
    type: "asset_drift",
    fingerprint: current.sha256,
    changedPaths: changedAssetPaths(snapshot.assets, current),
  });
}
