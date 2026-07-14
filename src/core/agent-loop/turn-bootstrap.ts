import { loadConfigForSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { VesicleMessage } from "../../providers/shared/types";
import { persistedImageAttachments } from "../attachments/store";
import { FileCheckpointManager } from "../checkpoints/file-history";
import { defaultPermissionRuntime } from "../permissions";
import { loadEngineAssetRuntime } from "../runtime/engine-assets";
import { createSessionStore } from "../session/store";
import { createTurnAgentManager } from "./agent-manager";
import { emitAssetDriftIfNeeded } from "./continuation-context";
import { generationMetadata, mergeGeneration } from "./generation";
import { resolveToolSurface } from "./tool-surface";
import type { RunLoopArgs } from "./turn-loop";
import type { RunPromptOptions } from "./types";
import { assertSessionHarnessIdentity, resolveProjectHarnessRuntime } from "../harness/activation";
import { loadSessionSnapshot } from "../session/store";

export async function bootstrapTurn(options: RunPromptOptions): Promise<RunLoopArgs> {
  const engine = options.engine ?? "etl";
  const rootDir = options.rootDir ?? process.cwd();
  const config = await loadConfigForSelection(options.providerSelection);
  const generation = mergeGeneration(config.generation, options.generation);
  const permission = options.permission ?? defaultPermissionRuntime;
  const provider = createProvider(config);
  const projectHarness = !options.assets && !options.harness
    ? await resolveProjectHarnessRuntime(rootDir)
    : undefined;
  const assets = options.assets ?? projectHarness?.assets;
  const harness = options.harness ?? projectHarness?.harness;
  const engineAssets = await loadEngineAssetRuntime(engine, rootDir, assets ? { resolver: assets } : {});
  const { profile, systemPrompt } = engineAssets;
  const toolSurface = await resolveToolSurface(
    profile,
    config.capabilities?.vision === true,
    permission.shellExecEnabled === true || permission.dangerouslySkipPermissions === true,
  );
  const agentManager = options.agentManager ?? createTurnAgentManager(rootDir, options.onEvent);
  const isNewSession = !options.sessionId;
  if (options.sessionId) {
    const snapshot = await loadSessionSnapshot(rootDir, options.sessionId, { synthesizeDanglingToolResults: false });
    assertSessionHarnessIdentity(snapshot.harness, harness?.identity);
    await emitAssetDriftIfNeeded(rootDir, options.sessionId, engineAssets.assets, options.onEvent);
  }
  const session = await createSessionStore(
    rootDir,
    options.sessionId,
    Object.hasOwn(options, "sessionParentUuid") ? { parentUuid: options.sessionParentUuid ?? null } : {},
  );

  if (isNewSession) {
    await session.append({
      role: "system",
      content: systemPrompt,
      metadata: {
        engine,
        provider: config.provider,
        providerId: config.providerId,
        model: config.model,
        permissionMode: permission.mode,
        ...(permission.dangerouslySkipPermissions ? { dangerouslySkipPermissions: true } : {}),
        ...generationMetadata(generation),
        profile: {
          displayName: profile.displayName,
          protocolVersion: profile.protocolVersion,
          tools: profile.defaultTools,
          effectiveModelTools: toolSurface.definitions.map((tool) => tool.function.name),
          ...(toolSurface.mcp.definitions.length > 0 ? { mcpTools: toolSurface.mcp.definitions.map((tool) => tool.function.name) } : {}),
          validators: profile.validators,
          stopGates: profile.stopGates,
        },
        assets: engineAssets.assets,
        ...(harness?.identity ? { harness: harness.identity } : {}),
      },
    });
  }

  const userRecord = options.prePersistedInputUuid
    ? { uuid: options.prePersistedInputUuid }
    : await session.append({
      role: "user",
      content: options.input,
      metadata: {
        ...(options.inputMetadata ?? {}),
        engine,
        provider: config.provider,
        providerId: config.providerId,
        model: config.model,
        ...generationMetadata(generation),
        ...(options.images ? { images: persistedImageAttachments(options.images) } : {}),
      },
    });
  const checkpoint = new FileCheckpointManager(rootDir, session, userRecord.uuid);
  await checkpoint.createSnapshot();
  const messages: VesicleMessage[] = options.messages ?? [{
    role: "user",
    content: options.input,
    ...(options.images ? { images: options.images } : {}),
  }];

  return {
    rootDir,
    config,
    provider,
    systemPrompt,
    tools: toolSurface.definitions,
    mcpRegistry: toolSurface.mcp,
    messages,
    session,
    profile,
    generation,
    checkpoint,
    signal: options.signal,
    onEvent: options.onEvent,
    agentManager,
    permission,
    permissionBroker: options.permissionBroker,
    harness,
    assets,
  };
}
