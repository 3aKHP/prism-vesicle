import { loadConfigForSelection } from "../../config/providers";
import type { VesicleConfig } from "../../config/env";
import { loadExperimentalQualityProfile } from "../../config/quality";
import { createProvider } from "../../providers";
import type { ProviderSelection } from "../../config/providers";
import type { VesicleMessage, VesicleRequest } from "../../providers/shared/types";
import { persistedImageAttachments } from "../attachments/store";
import { FileCheckpointManager } from "../checkpoints/file-history";
import { composeSystemPromptWithInstructions, selectionToRecord } from "../instructions";
import { composeInstructionBlocks } from "../instructions";
import { freezeInstructionBlocks } from "../instructions/instruction-context";
import { defaultPermissionRuntime } from "../permissions";
import { loadEngineAssetRuntime } from "../runtime/engine-assets";
import { bindExecutionRound, createSessionStore, executionIdentityMetadata, newLogicalTurnId, newProviderRoundId } from "../session/store";
import { AutoCompactBlockedError, runAutomaticCompaction } from "../compact/auto-compact";
import { estimateRequestTokens } from "../compact/context-budget";
import { createTurnAgentManager } from "./agent-manager";
import { emitAssetDriftIfNeeded } from "./continuation-context";
import { generationMetadata, mergeGeneration } from "./generation";
import { resolveToolSurface } from "./tool-surface";
import type { RunLoopArgs } from "./turn-loop";
import type { AgentLoopEvent, RunPromptOptions } from "./types";
import {
  assertSessionHarnessIdentity,
  requireProjectHarnessRuntime,
  resolveProjectHarnessRuntime,
} from "../harness/activation";
import { loadSessionSnapshot, type ResumedMessage, type SessionRecord, type SessionSnapshot } from "../session/store";
import type { EngineId } from "../engine/profile";

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
    let snapshot = await loadSessionSnapshot(rootDir, options.sessionId, { synthesizeDanglingToolResults: false });
    assertSessionHarnessIdentity(snapshot.harness, harness?.identity);
    if (engine === "stage") {
      if (!snapshot.stageBootstrap) throw new Error("Stage session is missing frozen bootstrap metadata.");
      systemPrompt = `${systemPrompt}\n\n${snapshot.stageBootstrap.renderedCharacterContext}`;
    }
    await emitAssetDriftIfNeeded(rootDir, options.sessionId, engineAssets.assets, options.onEvent);
    // Pre-turn auto-compaction runs only for an existing session and only when
    // limits.autoCompact is fully configured. It evaluates the projected next
    // request (including this incoming input) BEFORE the new user record is
    // persisted, compacts the old head if required, and — on a hard-ceiling
    // failure — throws before any session mutation so the caller retains the
    // draft. New sessions and Stage (no compaction) skip it. The compact
    // provider request is a standalone call, never a bootstrap turn, so it
    // cannot re-enter automatic evaluation.
    if (engine !== "stage" && config.limits?.autoCompact) {
      snapshot = await runExistingSessionPreTurnCompaction({
        rootDir,
        sessionId: options.sessionId,
        engine,
        config,
        composedSystemPrompt: systemPrompt,
        snapshot,
        input: options.input,
        images: options.images,
        generation,
        turnMaxTokens: options.generation?.maxTokens,
        providerSelection: options.providerSelection,
        signal: options.signal,
        onEvent: options.onEvent,
      });
    }
  }
  const session = await createSessionStore(
    rootDir,
    options.sessionId,
    Object.hasOwn(options, "sessionParentUuid") ? { parentUuid: options.sessionParentUuid ?? null } : {},
  );

  // A new top-level Agent Loop gets a fresh logical turn id, and its first
  // provider round is allocated alongside the initiating input. The ids stamp
  // the user record directly; the active-round map is bound only after all
  // fallible bootstrap appends succeed (just before return) so a failed append
  // can never leak a stale entry that runLoop's finally would never clear.
  const logicalTurnId = newLogicalTurnId();
  const providerRoundId = newProviderRoundId();

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

  // Emit the complete diagnostic state, including an empty state, so clients
  // can re-notify if a previously fixed target becomes invalid again.
  options.onEvent?.({
    type: "instruction_warning",
    sessionId: session.sessionId,
    engine,
    diagnostics: instructional.selection.diagnostics,
  });

  const userRecord = options.prePersistedInputUuid
    ? { uuid: options.prePersistedInputUuid }
    : await session.append({
      role: "user",
      content: options.input,
      metadata: {
        ...(options.inputMetadata ?? {}),
        ...executionIdentityMetadata({ logicalTurnId, providerRoundId }),
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
  // Freeze only after bootstrap's fallible persistence work is complete. From
  // here, runLoop owns cleanup on completion or failure, while pauses retain it.
  freezeInstructionBlocks(session.sessionId, composeInstructionBlocks(instructional.selection));
  // Bind the active round last, after every fallible append above has succeeded.
  // runLoop's finally clears it on completion/pause/error; a throw before this
  // point leaves no leaked entry.
  bindExecutionRound(session.sessionId, { logicalTurnId, providerRoundId });
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
    enginePrompt: engineAssets.systemPrompt,
    tools: toolSurface.definitions,
    mcpRegistry: toolSurface.mcp,
    messages,
    session,
    logicalTurnId,
    providerRoundId,
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

async function runExistingSessionPreTurnCompaction(params: {
  rootDir: string;
  sessionId: string;
  engine: EngineId;
  config: VesicleConfig;
  composedSystemPrompt: string;
  snapshot: SessionSnapshot;
  input: string;
  images?: VesicleMessage["images"];
  generation?: VesicleRequest["generation"];
  turnMaxTokens?: number;
  providerSelection?: Partial<ProviderSelection>;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
}): Promise<SessionSnapshot> {
  // Defer compaction while an interaction is unresolved (plan §7): the snapshot
  // of a session with a pending gate/permission/question/quality decision would
  // make the compact's pending-interaction guard throw, so emit compact_deferred
  // and leave the old head in place rather than attempting it.
  if (
    params.snapshot.pendingGate
    || params.snapshot.pendingEngineSwitch
    || params.snapshot.pendingUserQuestion
    || params.snapshot.pendingPermission
    || params.snapshot.pendingQualityDecision
    || params.snapshot.pendingQualityRewrite
  ) {
    params.onEvent?.({ type: "compact_deferred", phase: "pre-turn", reason: "a pending interaction must be resolved first" });
    return params.snapshot;
  }
  const lastContextInputTokens = findLastContextInputTokens(params.snapshot.records);
  const incoming: ResumedMessage = {
    role: "user",
    content: params.input,
    ...(params.images?.length ? { images: params.images } : {}),
  };
  const estimatedNextRequestTokens = estimateRequestTokens([...params.snapshot.messages, incoming], params.composedSystemPrompt);
  const result = await runAutomaticCompaction({
    rootDir: params.rootDir,
    sessionId: params.sessionId,
    engine: params.engine,
    providerSelection: params.providerSelection,
    generation: params.generation,
    signal: params.signal,
    onEvent: params.onEvent,
    phase: "pre-turn",
    budget: {
      config: params.config.limits?.autoCompact,
      limits: params.config.limits,
      generation: params.config.generation,
      turnMaxTokens: params.turnMaxTokens,
      lastContextInputTokens,
      estimatedNextRequestTokens,
    },
  });
  if (result.kind === "hard-failed") {
    throw new AutoCompactBlockedError(
      result.errorMessage,
      result.check.kind === "hard-ceiling"
        ? {
          projectedTokens: result.check.projectedTokens,
          hardInputCeilingTokens: result.check.hardInputCeilingTokens,
          softTriggerTokens: result.check.softTriggerTokens,
          usageSource: result.check.usageSource,
        }
        : undefined,
    );
  }
  if (result.kind === "compacted") {
    // Reload from the new checkpoint head so the incoming user record appends
    // after the checkpoint rather than the old pre-compaction head.
    return loadSessionSnapshot(params.rootDir, params.sessionId, { synthesizeDanglingToolResults: false });
  }
  return params.snapshot;
}

function findLastContextInputTokens(records: SessionRecord[]): number | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const usage = records[index]!.metadata?.usage as { contextInputTokens?: unknown } | undefined;
    if (usage && typeof usage.contextInputTokens === "number" && usage.contextInputTokens > 0) {
      return usage.contextInputTokens;
    }
  }
  return undefined;
}
