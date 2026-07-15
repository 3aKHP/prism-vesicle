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
import type { AssetResolver } from "../runtime/assets";
import type { HarnessRuntimeContext } from "../harness/driver";
import { mergeGeneration } from "./generation";
import type { AgentLoopEvent } from "./types";
import { resolveToolSurface } from "./tool-surface";
import {
  assertSessionHarnessIdentity,
  requireProjectHarnessRuntime,
  resolveProjectHarnessRuntime,
} from "../harness/activation";

export type ContinuationContextOptions = {
  engine: EngineId;
  rootDir?: string;
  sessionId: string;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  permission?: PermissionRuntimeOptions;
  onEvent?: (event: AgentLoopEvent) => void;
  harness?: HarnessRuntimeContext;
  assets?: AssetResolver;
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
  const projectHarness = !options.assets && !options.harness
    ? requireProjectHarnessRuntime(await resolveProjectHarnessRuntime(rootDir))
    : undefined;
  const assets = options.assets ?? projectHarness?.assets;
  const harness = options.harness ?? projectHarness?.harness;
  const snapshot = await loadSessionSnapshot(rootDir, options.sessionId, { synthesizeDanglingToolResults: false });
  assertSessionHarnessIdentity(snapshot.harness, harness?.identity);
  const engineAssets = await loadEngineAssetRuntime(options.engine, rootDir, assets ? { resolver: assets } : {});
  const { profile, systemPrompt } = engineAssets;
  if (behavior.emitAssetDrift !== false) {
    await emitAssetDriftIfNeeded(rootDir, options.sessionId, engineAssets.assets, options.onEvent);
  }
  const toolSurface = await resolveToolSurface(
    profile,
    config.capabilities?.vision === true,
    permission.shellExecEnabled === true || permission.dangerouslySkipPermissions === true,
    permission.shellInterpreter,
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
    harness,
    assets,
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
