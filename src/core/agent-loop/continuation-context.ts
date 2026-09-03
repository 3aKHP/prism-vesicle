import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import { readMcpOutputPreferences } from "../../config/project-preferences";
import { composeMcpOutputPersistenceHint } from "../../mcp/output-persistence";
import { loadExperimentalQualityProfile } from "../../config/quality";
import { createProvider, resolveProviderProxyPolicy } from "../../providers";
import type { VesicleRequest } from "../../providers/shared/types";
import type { EngineId } from "../engine/profile";
import { defaultPermissionRuntime } from "../permissions";
import type { PermissionRuntimeOptions } from "../permissions";
import { createSessionStore, loadSessionSnapshot } from "../session/store";
import { bindExecutionRound, recoverActiveIdentity } from "../session/store";
import { composeInstructionBlocks, composeSystemPromptWithInstructions } from "../instructions";
import { freezeInstructionBlocks, readFrozenInstructionBlocks } from "../instructions/instruction-context";
import { changedAssetPaths, loadEngineAssetRuntime } from "../runtime/engine-assets";
import type { AssetFingerprint } from "../runtime/assets";
import type { AssetResolver } from "../runtime/assets";
import type { HarnessRuntimeContext } from "../harness/driver";
import { appendHostContext } from "../prompt/host-context";
import { composeProjectStateBlock, freezeProjectStateBlock, readFrozenProjectStateBlock } from "../prompt/project-state";
import { declaresDirectoryQuery } from "../tools/directory-query";
import { createAssetResolver } from "../runtime/assets";
import { mergeGeneration } from "./generation";
import type { AgentLoopEvent, PendingUserInput } from "./types";
import type { SideQuestionContextSnapshot } from "../side-question/types";
import { resolveToolSurface, resolveWebSearchSurfaceOptions } from "./tool-surface";
import {
  catalogNames,
  composeSkillCatalogBlock,
  deriveSessionActivations,
  eligibleCatalogHashes,
  hydrateSessionActivations,
  pruneSessionActivations,
  resolveEngineEligibleCatalog,
  resolveSessionSkillCatalog,
} from "../skills";
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
  /** Cancels slow context rebuild steps (notably the MCP surface) when the turn is interrupted. */
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  onProviderContextSnapshot?: (snapshot: SideQuestionContextSnapshot) => void;
  harness?: HarnessRuntimeContext;
  assets?: AssetResolver;
  takePendingUserInputs?: () => PendingUserInput[];
  runToolBoundaryCommands?: () => Promise<void>;
};

export async function loadContinuationContext(
  options: ContinuationContextOptions,
  behavior: { emitAssetDrift?: boolean } = {},
) {
  const rootDir = options.rootDir ?? process.cwd();
  const permission = options.permission ?? defaultPermissionRuntime;
  const config = await loadConfigForSelection(options.providerSelection);
  const generation = mergeGeneration(config.generation, options.generation);
  const projectHarness = !options.assets && !options.harness
    ? requireProjectHarnessRuntime(await resolveProjectHarnessRuntime(rootDir))
    : undefined;
  const assets = options.assets ?? projectHarness?.assets;
  const harness = options.harness ?? projectHarness?.harness;
  const experimentalQuality = await loadExperimentalQualityProfile(harness?.quality);
  const snapshot = await loadSessionSnapshot(rootDir, options.sessionId, { synthesizeDanglingToolResults: false });
  assertSessionHarnessIdentity(snapshot.harness, harness?.identity);
  const engineAssets = await loadEngineAssetRuntime(options.engine, rootDir, assets ? { resolver: assets } : {});
  const { profile } = engineAssets;
  // Reuse the turn's frozen instruction blocks when an in-process continuation
  // resumes, so one turn observes one stable instruction set. The cache is
  // absent only after a process restart, which is a resume boundary that should
  // re-read current disk.
  const frozenBlocks = readFrozenInstructionBlocks(options.sessionId);
  let systemPrompt: string;
  if (frozenBlocks !== undefined) {
    systemPrompt = frozenBlocks.length > 0 ? `${engineAssets.systemPrompt}\n\n${frozenBlocks}` : engineAssets.systemPrompt;
  } else {
    const instructional = await composeSystemPromptWithInstructions(options.engine, engineAssets.systemPrompt, rootDir);
    systemPrompt = instructional.systemPrompt;
    freezeInstructionBlocks(options.sessionId, composeInstructionBlocks(instructional.selection));
    options.onEvent?.({
      type: "instruction_warning",
      sessionId: options.sessionId,
      engine: options.engine,
      diagnostics: instructional.selection.diagnostics,
    });
  }
  if (behavior.emitAssetDrift !== false) {
    await emitAssetDriftIfNeeded(rootDir, options.sessionId, engineAssets.assets, options.onEvent);
  }
  // Skills (Phase 2): the session catalog freeze and the engine eligibility
  // filter mirror bootstrapTurn, so a resumed continuation observes the same
  // catalog, activation registry, and prompt block as the turn it continues.
  const frozenSkillCatalog = await resolveSessionSkillCatalog(
    rootDir,
    process.env,
    profile,
    options.sessionId,
    snapshot.skillCatalogSnapshot,
    config.limits?.contextWindow,
  );
  const skillCatalog = resolveEngineEligibleCatalog(frozenSkillCatalog, profile);
  hydrateSessionActivations(options.sessionId, deriveSessionActivations(snapshot.records));
  pruneSessionActivations(options.sessionId, eligibleCatalogHashes(skillCatalog));
  const skillCatalogBlock = composeSkillCatalogBlock(skillCatalog.catalog);
  systemPrompt = appendHostContext(systemPrompt, skillCatalogBlock);
  const frozenProjectState = readFrozenProjectStateBlock(options.sessionId);
  const projectStateBlock = frozenProjectState ?? (declaresDirectoryQuery(profile.defaultTools)
    ? await composeProjectStateBlock(rootDir, assets ?? createAssetResolver(rootDir))
    : "");
  if (frozenProjectState === undefined) freezeProjectStateBlock(options.sessionId, projectStateBlock);
  systemPrompt = appendHostContext(systemPrompt, projectStateBlock);
  const mcpOutputPreferences = await readMcpOutputPreferences(rootDir);
  const mcpOutputPersistence = mcpOutputPreferences.persist;
  const toolSurface = await resolveToolSurface(
    profile,
    config.capabilities?.vision === true,
    permission.shellExecEnabled === true || permission.dangerouslySkipPermissions === true,
    permission.shellInterpreter,
    mcpOutputPersistence
      ? { outputPersistence: { sessionId: options.sessionId, autoTruncate: mcpOutputPreferences.autoTruncate }, signal: options.signal }
      : { signal: options.signal },
    { catalogNames: catalogNames(skillCatalog) },
    await resolveWebSearchSurfaceOptions(config, options.sessionId, profile),
  );
  if (mcpOutputPersistence && toolSurface.mcp.definitions.length > 0) {
    systemPrompt = appendHostContext(systemPrompt, composeMcpOutputPersistenceHint(options.sessionId));
  }
  const session = await createSessionStore(rootDir, options.sessionId);
  const proxyPolicy = await resolveProviderProxyPolicy();
  const provider = createProvider(config, { sessionId: session.sessionId, proxyPolicy });
  // Recover the logical turn + provider round the paused interaction belongs to
  // and re-bind them as the active round, so every resolution record this
  // continuation appends carries the original ids and a resumed pause never
  // creates a new logical turn. Legacy sessions without identity fall back to
  // the old append behavior (no round bound → no stamping).
  const identity = recoverActiveIdentity(snapshot.records);
  if (identity) bindExecutionRound(session.sessionId, identity);
  return {
    rootDir,
    permission,
    config,
    generation,
    provider,
    profile,
    systemPrompt,
    enginePrompt: engineAssets.systemPrompt,
    projectStateBlock,
    toolSurface,
    mcpOutputPersistence,
    skillCatalog,
    session,
    harness,
    assets,
    experimentalQuality,
    ...(identity ? { identity } : {}),
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
