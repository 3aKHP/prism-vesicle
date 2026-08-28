import { loadConfigForSelection } from "../../config/providers";
import { readMcpOutputPreferences } from "../../config/project-preferences";
import { composeMcpOutputPersistenceHint } from "../../mcp/output-persistence";
import type { VesicleConfig } from "../../config/env";
import { loadExperimentalQualityProfile } from "../../config/quality";
import { createProvider, resolveProviderProxyPolicy } from "../../providers";
import type { ProviderSelection } from "../../config/providers";
import type { VesicleMessage, VesicleRequest } from "../../providers/shared/types";
import { persistedImageAttachments } from "../attachments/store";
import { FileCheckpointManager } from "../checkpoints/file-history";
import { composeSystemPromptWithInstructions } from "../instructions";
import { composeInstructionBlocks } from "../instructions";
import { freezeInstructionBlocks } from "../instructions/instruction-context";
import { defaultPermissionRuntime } from "../permissions";
import { loadEngineAssetRuntime } from "../runtime/engine-assets";
import { bindExecutionRound, createSessionStore, executionIdentityMetadata, newLogicalTurnId, newProviderRoundId } from "../session/store";
import { AutoCompactBlockedError, runAutomaticCompaction } from "../compact/auto-compact";
import { estimateRequestTokens } from "../compact/context-budget";
import { toVesicleMessage } from "../compact/summary-generator";
import { createTurnAgentManager } from "./agent-manager";
import { emitAssetDriftIfNeeded } from "./continuation-context";
import { generationMetadata, mergeGeneration } from "./generation";
import { resolveToolSurface, resolveWebSearchSurfaceOptions } from "./tool-surface";
import { buildSessionHeaderRecord } from "./session-init";
import type { RunLoopArgs } from "./turn-loop";
import type { AgentLoopEvent, RunPromptOptions } from "./types";
import {
  assertSessionHarnessIdentity,
  requireProjectHarnessRuntime,
  resolveProjectHarnessRuntime,
} from "../harness/activation";
import { loadSessionSnapshot, type ResumedMessage, type SessionRecord, type SessionSnapshot } from "../session/store";
import {
  catalogNames,
  composeSkillCatalogBlock,
  deriveSessionActivations,
  hydrateSessionActivations,
  isMeaningfulSkillCatalogSnapshot,
  pruneSessionActivations,
  resolveEngineEligibleCatalog,
  resolveSessionSkillCatalog,
  SKILL_CATALOG_RECORD_KIND,
  snapshotSkillCatalog,
} from "../skills";
import type { EngineId } from "../engine/profile";
import type { ToolDefinition } from "../tools";
import { createAssetResolver } from "../runtime/assets";
import { appendHostContext } from "../prompt/host-context";
import { composeProjectStateBlock, freezeProjectStateBlock } from "../prompt/project-state";
import { declaresDirectoryQuery } from "../tools/directory-query";

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

  // Load the existing session's snapshot before resolving the Skill catalog:
  // the persisted catalog snapshot and the durable activation records are the
  // resume authority for the frozen catalog and the activation registry.
  let snapshot: SessionSnapshot | undefined;
  if (options.sessionId) {
    snapshot = await loadSessionSnapshot(rootDir, options.sessionId, {
      synthesizeDanglingToolResults: false,
      // A branched turn (regenerate) reads the snapshot ending at the fork
      // point, excluding later sibling subtrees, so harness identity, Skill
      // hydration, and the round-0 message list reflect the fresh-context branch.
      ...(options.branchHeadUuid ? { headUuid: options.branchHeadUuid } : {}),
    });
    assertSessionHarnessIdentity(snapshot.harness, harness?.identity);
    if (engine === "stage") {
      if (!snapshot.stageBootstrap) throw new Error("Stage session is missing frozen bootstrap metadata.");
      systemPrompt = `${systemPrompt}\n\n${snapshot.stageBootstrap.renderedCharacterContext}`;
    }
  }
  const session = await createSessionStore(
    rootDir,
    options.sessionId,
    Object.hasOwn(options, "sessionParentUuid") ? { parentUuid: options.sessionParentUuid ?? null } : {},
  );
  const proxyPolicy = await resolveProviderProxyPolicy();
  const provider = createProvider(config, { sessionId: session.sessionId, proxyPolicy });

  // Skills (Phase 2): freeze the session catalog (resume re-resolves by the
  // persisted snapshot's name+hash), filter it for this engine, hydrate the
  // activation registry from durable records, and prune entries ineligible in
  // this engine. The catalog block appends after the composed prompt only
  // when at least one Skill is eligible, so a Skill-less session keeps the
  // composed prompt byte-identical.
  const frozenSkillCatalog = await resolveSessionSkillCatalog(
    rootDir,
    process.env,
    profile,
    session.sessionId,
    snapshot?.skillCatalogSnapshot,
    config.limits?.contextWindow,
  );
  const skillCatalog = resolveEngineEligibleCatalog(frozenSkillCatalog, profile);
  const skillCatalogSnapshot = snapshotSkillCatalog(frozenSkillCatalog);
  if (snapshot) {
    hydrateSessionActivations(session.sessionId, deriveSessionActivations(snapshot.records));
    pruneSessionActivations(session.sessionId, new Set(catalogNames(skillCatalog)));
  }
  const skillCatalogBlock = composeSkillCatalogBlock(skillCatalog.catalog);
  systemPrompt = appendHostContext(systemPrompt, skillCatalogBlock);
  // Project State is live Host context, not session identity or conversation
  // history. It is frozen in process for pauses and observed again after a
  // restart or at the next top-level turn.
  let identitySystemPrompt = systemPrompt;
  const projectStateBlock = declaresDirectoryQuery(profile.defaultTools)
    ? await composeProjectStateBlock(rootDir, assets ?? createAssetResolver(rootDir))
    : "";
  systemPrompt = appendHostContext(systemPrompt, projectStateBlock);

  const mcpOutputPreferences = await readMcpOutputPreferences(rootDir);
  const mcpOutputPersistence = mcpOutputPreferences.persist;
  const toolSurface = await resolveToolSurface(
    profile,
    config.capabilities?.vision === true,
    permission.shellExecEnabled === true || permission.dangerouslySkipPermissions === true,
    permission.shellInterpreter,
    mcpOutputPersistence
      ? { outputPersistence: { sessionId: session.sessionId, autoTruncate: mcpOutputPreferences.autoTruncate }, signal: options.signal }
      : { signal: options.signal },
    { catalogNames: catalogNames(skillCatalog) },
    await resolveWebSearchSurfaceOptions(config, session.sessionId, profile),
  );
  if (mcpOutputPersistence && toolSurface.mcp.definitions.length > 0) {
    const hint = composeMcpOutputPersistenceHint(session.sessionId);
    systemPrompt = appendHostContext(systemPrompt, hint);
    identitySystemPrompt = appendHostContext(identitySystemPrompt, hint);
  }
  const agentManager = options.agentManager ?? createTurnAgentManager(rootDir, options.onEvent);
  let compactedSnapshot: SessionSnapshot | undefined;
  if (options.sessionId && snapshot) {
    await emitAssetDriftIfNeeded(rootDir, options.sessionId, engineAssets.assets, options.onEvent);
    // Pre-turn auto-compaction runs only for an existing session and only when
    // limits.autoCompact is fully configured. It evaluates the projected next
    // request (including this incoming input) BEFORE the new user record is
    // persisted, compacts the old head if required, and — on a hard-ceiling
    // failure — throws before any session mutation so the caller retains the
    // draft. New sessions and Stage (no compaction) skip it. The compact
    // provider request is a standalone call, never a bootstrap turn, so it
    // cannot re-enter automatic evaluation.
    // Pre-turn auto-compaction is skipped for branched turns (branchHeadUuid
    // set): the compaction service appends to the physical tail and is not
    // branch-fork-aware, so compacting before the forked store's first append
    // would fold the old sibling subtree's summary into the fresh-context
    // branch. A regenerate re-runs history that already met the budget when the
    // original turn ran, so skipping is safe; mid-turn compaction (by which
    // point the branch IS the physical tail) still guards the hard ceiling.
    if (engine !== "stage" && config.limits?.autoCompact && !options.branchHeadUuid) {
      const compacted = await runExistingSessionPreTurnCompaction({
        rootDir,
        sessionId: options.sessionId,
        engine,
        config,
        tools: toolSurface.definitions,
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
      snapshot = compacted.snapshot;
      if (compacted.compacted) compactedSnapshot = snapshot;
    }
  }

  // A new top-level Agent Loop gets a fresh logical turn id unless it is a
  // regenerate candidate rooted at a deliberately reused user record. In that
  // case the candidate must share the user's id so compaction retains the
  // prompt and selected response as one indivisible logical turn. The first
  // provider round is always new. The active-round map is bound only after all
  // fallible bootstrap appends succeed (just before return) so a failed append
  // can never leak a stale entry that runLoop's finally would never clear.
  const logicalTurnId = options.prePersistedInputLogicalTurnId ?? newLogicalTurnId();
  const providerRoundId = newProviderRoundId();

  if (isNewSession) {
    await session.append(
      buildSessionHeaderRecord({
        systemPrompt: identitySystemPrompt,
        engine,
        config,
        permission,
        generation,
        profile,
        toolSurface,
        assets: engineAssets.assets,
        instructionalSelection: instructional.selection,
        harnessIdentity: harness?.identity,
        skillCatalogSnapshot,
      }),
    );
  } else if (snapshot && !snapshot.skillCatalogSnapshot && isMeaningfulSkillCatalogSnapshot(skillCatalogSnapshot)) {
    // A resumed legacy session without a persisted snapshot: make the fresh
    // freeze durable so the next resume re-resolves by name+hash instead of
    // re-freezing whatever the store happens to contain.
    await session.append({
      role: "system",
      content: "Skill catalog frozen for this session.",
      metadata: { kind: SKILL_CATALOG_RECORD_KIND, skills: skillCatalogSnapshot },
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

  let userRecord: { uuid: string };
  if (options.prePersistedInputUuid) {
    userRecord = { uuid: options.prePersistedInputUuid };
  } else {
    userRecord = await session.append({
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
  }
  const checkpoint = new FileCheckpointManager(rootDir, session, userRecord.uuid);
  await checkpoint.createSnapshot();
  options.onSessionReady?.(session.sessionId, session.sessionPath);
  // Freeze only after bootstrap's fallible persistence work is complete. From
  // here, runLoop owns cleanup on completion or failure, while pauses retain it.
  freezeInstructionBlocks(session.sessionId, composeInstructionBlocks(instructional.selection));
  freezeProjectStateBlock(session.sessionId, projectStateBlock);
  // Bind the active round last, after every fallible append above has succeeded.
  // runLoop's finally clears it on completion/pause/error; a throw before this
  // point leaves no leaked entry.
  bindExecutionRound(session.sessionId, { logicalTurnId, providerRoundId });
  const incomingMessage: VesicleMessage = {
    role: "user",
    content: options.input,
    ...(options.images ? { images: options.images } : {}),
  };
  const messages: VesicleMessage[] = compactedSnapshot
    ? [...compactedSnapshot.messages.map(toVesicleMessage), incomingMessage]
    : options.messages ?? [incomingMessage];

  return {
    rootDir,
    config,
    provider,
    systemPrompt,
    enginePrompt: engineAssets.systemPrompt,
    projectStateBlock,
    tools: toolSurface.definitions,
    mcpRegistry: toolSurface.mcp,
    mcpOutputPersistence,
    messages,
    session,
    logicalTurnId,
    providerRoundId,
    profile,
    skillCatalog,
    generation,
    checkpoint,
    signal: options.signal,
    onEvent: options.onEvent,
    onSessionTitleChanged: options.onSessionTitleChanged,
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
  tools: ToolDefinition[];
  composedSystemPrompt: string;
  snapshot: SessionSnapshot;
  input: string;
  images?: VesicleMessage["images"];
  generation?: VesicleRequest["generation"];
  turnMaxTokens?: number;
  providerSelection?: Partial<ProviderSelection>;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
}): Promise<{ snapshot: SessionSnapshot; compacted: boolean }> {
  // Defer compaction while an interaction is unresolved (plan §7): the snapshot
  // of a session with a pending gate/permission/question/quality decision would
  // make the compact's pending-interaction guard throw, so emit compact_deferred
  // and leave the old head in place rather than attempting it.
  if (
    params.snapshot.pendingGate
    || params.snapshot.pendingEngineSwitch
    || params.snapshot.pendingUserQuestion
    || params.snapshot.pendingPermission
    || params.snapshot.pendingDelegationRetry
    || params.snapshot.pendingDelegationDecisionRecovery
    || params.snapshot.pendingQualityDecision
    || params.snapshot.pendingQualityRewrite
  ) {
    params.onEvent?.({ type: "compact_deferred", phase: "pre-turn", reason: "a pending interaction must be resolved first" });
    return { snapshot: params.snapshot, compacted: false };
  }
  const lastObservation = findLastContextObservation(params.snapshot.records);
  const incoming: ResumedMessage = {
    role: "user",
    content: params.input,
    ...(params.images?.length ? { images: params.images } : {}),
  };
  const estimatedNextRequestTokens = estimateRequestTokens(
    [...params.snapshot.messages, incoming],
    params.composedSystemPrompt,
    params.tools,
  );
  const result = await runAutomaticCompaction({
    rootDir: params.rootDir,
    sessionId: params.sessionId,
    engine: params.engine,
    providerSelection: params.providerSelection,
    generation: params.generation,
    signal: params.signal,
    onEvent: params.onEvent,
    phase: "pre-turn",
    estimateReplacementTokens: (replacement) => estimateRequestTokens(
      [...replacement.map(toVesicleMessage), toVesicleMessage(incoming)],
      params.composedSystemPrompt,
      params.tools,
    ),
    budget: {
      config: params.config.limits?.autoCompact,
      limits: params.config.limits,
      generation: params.config.generation,
      turnMaxTokens: params.turnMaxTokens,
      lastContextInputTokens: lastObservation?.contextInputTokens,
      lastRequestObservation: lastObservation?.estimatedRequestTokens !== undefined
        ? {
          contextInputTokens: lastObservation.contextInputTokens,
          estimatedRequestTokens: lastObservation.estimatedRequestTokens,
        }
        : undefined,
      estimatedNextRequestTokens,
    },
  });
  if (result.kind === "cancelled") throw result.error;
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
    return {
      snapshot: await loadSessionSnapshot(params.rootDir, params.sessionId, { synthesizeDanglingToolResults: false }),
      compacted: true,
    };
  }
  return { snapshot: params.snapshot, compacted: false };
}

function findLastContextObservation(
  records: SessionRecord[],
): { contextInputTokens: number; estimatedRequestTokens?: number } | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const metadata = records[index]!.metadata;
    const usage = metadata?.usage as { contextInputTokens?: unknown } | undefined;
    if (usage && typeof usage.contextInputTokens === "number" && usage.contextInputTokens > 0) {
      const estimatedRequestTokens = metadata?.requestEstimateTokens;
      return {
        contextInputTokens: usage.contextInputTokens,
        ...(typeof estimatedRequestTokens === "number" && estimatedRequestTokens >= 0 ? { estimatedRequestTokens } : {}),
      };
    }
  }
  return undefined;
}
