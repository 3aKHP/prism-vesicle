import { loadConfigForSelection } from "../../config/providers";
import { loadExperimentalQualityProfile } from "../../config/quality";
import { createProvider } from "../../providers";
import type { VesicleMessage } from "../../providers/shared/types";
import { persistedImageAttachments } from "../attachments/store";
import { FileCheckpointManager } from "../checkpoints/file-history";
import { composeSystemPromptWithInstructions, selectionToRecord } from "../instructions";
import { composeInstructionBlocks } from "../instructions";
import { freezeInstructionBlocks } from "./instruction-context";
import { defaultPermissionRuntime } from "../permissions";
import { loadEngineAssetRuntime } from "../runtime/engine-assets";
import { createSessionStore } from "../session/store";
import { createTurnAgentManager } from "./agent-manager";
import { emitAssetDriftIfNeeded } from "./continuation-context";
import { generationMetadata, mergeGeneration } from "./generation";
import { resolveToolSurface } from "./tool-surface";
import type { RunLoopArgs } from "./turn-loop";
import type { RunPromptOptions } from "./types";
import {
  assertSessionHarnessIdentity,
  requireProjectHarnessRuntime,
  resolveProjectHarnessRuntime,
} from "../harness/activation";
import { loadSessionSnapshot } from "../session/store";

export async function bootstrapTurn(options: RunPromptOptions): Promise<RunLoopArgs> {
  const engine = options.engine ?? "etl";
  const rootDir = options.rootDir ?? process.cwd();
  const isNewSession = !options.sessionId;
  if (engine === "stage" && isNewSession) {
    throw new Error("Stage sessions must start with /stage <character-card-path> <scenario-card-path> so bootstrap context is persisted before the first player action.");
  }
  const config = await loadConfigForSelection(options.providerSelection);
  const generation = mergeGeneration(config.generation, options.generation);
  const permission = options.permission ?? defaultPermissionRuntime;
  const provider = createProvider(config);
  const projectHarness = !options.assets && !options.harness
    ? requireProjectHarnessRuntime(await resolveProjectHarnessRuntime(rootDir))
    : undefined;
  const assets = options.assets ?? projectHarness?.assets;
  const harness = options.harness ?? projectHarness?.harness;
  const experimentalQuality = Object.hasOwn(options, "experimentalQuality")
    ? options.experimentalQuality
    : await loadExperimentalQualityProfile(harness?.quality);
  const engineAssets = await loadEngineAssetRuntime(engine, rootDir, assets ? { resolver: assets } : {});
  const { profile } = engineAssets;
  const instructional = await composeSystemPromptWithInstructions(engine, engineAssets.systemPrompt, rootDir);
  let systemPrompt = instructional.systemPrompt;
  const toolSurface = await resolveToolSurface(
    profile,
    config.capabilities?.vision === true,
    permission.shellExecEnabled === true || permission.dangerouslySkipPermissions === true,
    permission.shellInterpreter,
  );
  const agentManager = options.agentManager ?? createTurnAgentManager(rootDir, options.onEvent);
  if (options.sessionId) {
    const snapshot = await loadSessionSnapshot(rootDir, options.sessionId, { synthesizeDanglingToolResults: false });
    assertSessionHarnessIdentity(snapshot.harness, harness?.identity);
    if (engine === "stage") {
      if (!snapshot.stageBootstrap) throw new Error("Stage session is missing frozen bootstrap metadata.");
      systemPrompt = `${systemPrompt}\n\n${snapshot.stageBootstrap.renderedCharacterContext}`;
    }
    await emitAssetDriftIfNeeded(rootDir, options.sessionId, engineAssets.assets, options.onEvent);
  }
  const session = await createSessionStore(
    rootDir,
    options.sessionId,
    Object.hasOwn(options, "sessionParentUuid") ? { parentUuid: options.sessionParentUuid ?? null } : {},
  );

  // Freeze this turn's instruction blocks so in-process continuations reuse
  // them instead of re-reading disk mid-turn. A restart loses the cache, so a
  // resumed continuation re-reads current disk (a resume boundary).
  freezeInstructionBlocks(session.sessionId, composeInstructionBlocks(instructional.selection));

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
        instructions: selectionToRecord(instructional.selection),
        ...(harness?.identity ? { harness: harness.identity } : {}),
      },
    });
  }

  // Surface instruction diagnostics (invalid, linked, or oversized selected
  // scopes) as a visible warning so the user learns why a rule was not loaded
  // without having to run /instructions.
  if (instructional.selection.diagnostics.length > 0) {
    options.onEvent?.({ type: "instruction_warning", diagnostics: instructional.selection.diagnostics });
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
  options.onSessionReady?.(session.sessionId, session.sessionPath);
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
    onProviderContextSnapshot: options.onProviderContextSnapshot,
    agentManager,
    permission,
    permissionBroker: options.permissionBroker,
    harness,
    assets,
    experimentalQuality,
    takePendingUserInputs: options.takePendingUserInputs,
    runToolBoundaryCommands: options.runToolBoundaryCommands,
  };
}
