import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import { createProvider, resolveProviderProxyPolicy } from "../../providers";
import type { ProviderAdapter, ProviderCompactResult, ProviderRetryInfo, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { loadEngineProfile, type EngineId } from "../engine/profile";
import { composeSystemPromptWithInstructions } from "../instructions";
import { composeSystemPrompt, loadPromptBundle } from "../prompt/loader";
import { createSessionStore, loadSessionSnapshot, type ResumedMessage, type SessionSnapshot } from "../session/store";
import { prepareSkillCompactionReattach, removeSessionActivations, SKILL_CONTEXT_LOST_KIND } from "../skills";
import type { SkillContextLoss } from "../skills";
import { selectReplacement } from "./replacement-builder";
import { formatCompactSummary, generatePortableSummary, toVesicleMessage } from "./summary-generator";
import { buildCompactReplacementMessages, installCompactCheckpoint } from "./checkpoint-installer";

export { formatCompactSummary };

export const COMPACT_BOUNDARY_KIND = "compact-boundary";
export const COMPACT_SUMMARY_KIND = "compact-summary";

export const ERROR_NOTHING_TO_COMPACT = "Nothing left to compact; the newest complete turn is already the retained tail.";
export const ERROR_NOT_ENOUGH_MESSAGES_TO_COMPACT = ERROR_NOTHING_TO_COMPACT;
export const ERROR_PENDING_INTERACTION = "Resolve the pending interaction before compacting.";

type CompactPoint = {
  uuid: string;
  parentUuid: string | null;
  content: string;
};

export type ConversationCompact = {
  snapshot: SessionSnapshot;
  summary: string;
  parentUuid: string | null;
  messagesSummarized: number;
};

export type ConversationCompactFromPoint = ConversationCompact & {
  prompt: string;
};

const NO_TOOLS_COMPACT_PREAMBLE = `
CRITICAL: Respond with TEXT ONLY. Do NOT call tools.

- You already have the context to summarize in the conversation above.
- Do not ask follow-up questions.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
`.trim();

const PARTIAL_COMPACT_PROMPT = `
Summarize the conversation context from the selected user message onward so a
future model can continue the work without the removed turns. Preserve user
intent, decisions, generated files, tool outcomes, unresolved issues, and the
state needed to continue. Do not call tools. Respond with plain text only in a
single <summary>...</summary> block.
`.trim();

export type PortableCompactionTrigger = "manual" | "auto";
export type PortableCompactionPhase = "pre-turn" | "mid-turn" | "manual";
export type PortableCompactionReason = "requested" | "soft-threshold" | "hard-ceiling" | "model-switch";

export type PortableCompactionOutcome =
  | {
      kind: "completed";
      snapshot: SessionSnapshot;
      summary: string;
      checkpointUuid: string;
      messagesSummarized: number;
      retainedUnits: number;
      contextWindow?: number;
      projectedAfterTokens?: number;
      nativeProjectionInstalled: boolean;
      /** Active Skills whose exact body compaction could not retain; they require reactivation. */
      skillContextLoss?: SkillContextLoss[];
    }
  | { kind: "nothing-to-compact" }
  | { kind: "cancelled"; error: unknown }
  | { kind: "failed"; error: unknown };

export type RunPortableCompactionOptions = {
  rootDir: string;
  sessionId: string;
  engine: EngineId;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  trigger: PortableCompactionTrigger;
  phase: PortableCompactionPhase;
  reason: PortableCompactionReason;
  instructions?: string;
  signal?: AbortSignal;
  onRetry?: (info: ProviderRetryInfo) => void;
  automaticBudget?: {
    beforeTokens: number;
    beforeEstimateTokens?: number;
    beforeSource: "provider" | "estimated";
    softTriggerTokens: number;
    hardInputCeilingTokens: number;
    estimateReplacementTokens: (messages: ResumedMessage[]) => number;
    projectReplacementTokens: (estimatedTokens: number) => number;
  };
};

/**
 * The shared portable-compaction pipeline used by manual `/compact` and the
 * automatic pre-turn/mid-turn triggers. Transaction boundary (plan §3):
 * produce + validate the summary first; the installer then builds + validates
 * the replacement and appends one record. A provider failure, malformed
 * payload, or append error leaves the former head active and usable — nothing
 * is installed in memory. Returns a typed outcome so automatic callers can
 * distinguish "nothing to compact" and "failed" without catching.
 */
export async function runPortableCompaction(options: RunPortableCompactionOptions): Promise<PortableCompactionOutcome> {
  const full = await loadSessionSnapshot(options.rootDir, options.sessionId);
  assertNoPendingInteraction(full);

  const config = await loadConfigForSelection(options.providerSelection);
  const selection = selectReplacement(full.records, { contextWindow: config.limits?.contextWindow });
  if (!selection) return { kind: "nothing-to-compact" };

  // Active Skill procedure context is either reattached verbatim inside the
  // replacement history or reported as lost (never silently dropped).
  const skillReattach = await prepareSkillCompactionReattach({
    rootDir: options.rootDir,
    env: process.env,
    sessionId: options.sessionId,
    profile: { id: options.engine },
    records: full.records,
    persistedSnapshot: full.skillCatalogSnapshot,
    contextWindow: config.limits?.contextWindow,
  });

  let summary: string;
  try {
    summary = await generatePortableSummary({
      rootDir: options.rootDir,
      sessionId: options.sessionId,
      engine: options.engine,
      providerSelection: options.providerSelection,
      generation: options.generation,
      evictedRecords: selection.evictedRecords,
      ...(selection.previousSummary ? { previousSummary: selection.previousSummary } : {}),
      instructions: options.instructions,
      signal: options.signal,
      onRetry: options.onRetry,
    });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) return { kind: "cancelled", error };
    return { kind: "failed", error };
  }

  let nativeProjection: ProviderCompactResult["providerState"] | undefined;
  let compactProvider: ProviderAdapter | undefined;
  if (config.capabilities?.remoteCompact === true) {
    try {
      const proxyPolicy = await resolveProviderProxyPolicy();
      const provider = createProvider(config, { sessionId: options.sessionId, proxyPolicy });
      if (provider.compact) {
        compactProvider = provider;
        const compacted = await provider.compact({
          id: `${options.sessionId}:compact:${selection.sourceHeadUuid}`,
          model: { provider: config.providerId, model: config.model },
          messages: full.messages.map(toVesicleMessage),
          signal: options.signal,
          onRetry: options.onRetry,
        });
        nativeProjection = compacted.providerState;
      }
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) return { kind: "cancelled", error };
      // The portable projection remains authoritative. Remote compact is an
      // optional same-source optimization and never blocks local recovery.
    }
  }

  const replacementMessages = buildCompactReplacementMessages(selection, summary, skillReattach.reattach);
  let projectedAfterTokens: number | undefined;
  let installed: Awaited<ReturnType<typeof installCompactCheckpoint>>;
  try {
    const replacementEstimateTokens = options.automaticBudget?.estimateReplacementTokens(replacementMessages);
    projectedAfterTokens = replacementEstimateTokens === undefined
      ? undefined
      : options.automaticBudget!.projectReplacementTokens(replacementEstimateTokens);
    if (
      replacementEstimateTokens !== undefined
      && options.automaticBudget?.beforeEstimateTokens !== undefined
      && replacementEstimateTokens >= options.automaticBudget.beforeEstimateTokens
    ) {
      throw new Error(
        `Automatic compaction did not reduce the estimated next request (${replacementEstimateTokens} replacement tokens >= ${options.automaticBudget.beforeEstimateTokens} before compaction).`,
      );
    }
    if (
      projectedAfterTokens !== undefined
      && projectedAfterTokens > options.automaticBudget!.hardInputCeilingTokens
    ) {
      throw new Error(
        `Automatic compaction could not reduce the next request below the hard ceiling (${projectedAfterTokens} projected tokens > ${options.automaticBudget!.hardInputCeilingTokens}).`,
      );
    }
    const session = await createSessionStore(options.rootDir, options.sessionId);
    installed = await installCompactCheckpoint({
      rootDir: options.rootDir,
      sessionId: options.sessionId,
      session,
      selection,
      summary,
      replacementMessages,
      ...(nativeProjection ? { nativeProjection } : {}),
      trigger: options.trigger,
      phase: options.phase,
      reason: options.reason,
      createdWith: { providerId: config.providerId, model: config.model, engine: options.engine },
      accounting: {
        ...(config.limits?.contextWindow ? { contextWindow: config.limits.contextWindow } : {}),
        ...(options.automaticBudget ? {
          softTriggerTokens: options.automaticBudget.softTriggerTokens,
          hardInputCeilingTokens: options.automaticBudget.hardInputCeilingTokens,
          beforeTokens: options.automaticBudget.beforeTokens,
          beforeSource: options.automaticBudget.beforeSource,
        } : { beforeSource: "unknown" as const }),
        ...(projectedAfterTokens !== undefined ? { projectedAfterTokens } : {}),
      },
    });
    if (nativeProjection && compactProvider?.commitCompact) {
      // The checkpoint is already durable. Provider-local continuation cleanup
      // is best effort and must not turn a committed append into a failed result.
      try {
        compactProvider.commitCompact();
      } catch {
        // The next request still sees the native marker and starts a new chain.
      }
    }
    if (skillReattach.lost.length > 0) {
      await session.append({
        role: "system",
        content: `Compaction could not retain the active context of ${skillReattach.lost.length} Skill(s): ${skillReattach.lost.map((lost) => lost.name).join(", ")}. Reactivate with activate_skill if the procedure is still needed.`,
        metadata: { kind: SKILL_CONTEXT_LOST_KIND, skills: skillReattach.lost },
      });
    }

  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) return { kind: "cancelled", error };
    return { kind: "failed", error };
  }

  // The append above is the transaction boundary. Do not turn a later reload
  // problem into a "failed without mutation" outcome: the checkpoint is
  // already durable and callers must see the reload error directly.
  const snapshot = await loadSessionSnapshot(options.rootDir, options.sessionId, { headUuid: installed.checkpointUuid });
  // Lost Skills are no longer active: remove them from the registry so dedup
  // cannot suppress a deliberate reactivation.
  if (skillReattach.lost.length > 0) {
    removeSessionActivations(options.sessionId, skillReattach.lost.map((lost) => lost.name));
  }
  const messagesSummarized = selection.evictedRecords.filter((record) => record.role !== "system").length;
  const retainedUnits = selection.retainedRecords.filter((record) => record.role !== "system").length;
  return {
    kind: "completed",
    snapshot,
    summary,
    checkpointUuid: installed.checkpointUuid,
    messagesSummarized,
    retainedUnits,
    nativeProjectionInstalled: Boolean(nativeProjection),
    ...(config.limits?.contextWindow ? { contextWindow: config.limits.contextWindow } : {}),
    ...(projectedAfterTokens !== undefined ? { projectedAfterTokens } : {}),
    ...(skillReattach.lost.length > 0 ? { skillContextLoss: skillReattach.lost } : {}),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort|cancel/i.test(error.message));
}

export async function compactConversation(options: {
  rootDir: string;
  sessionId: string;
  engine: EngineId;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  instructions?: string;
  signal?: AbortSignal;
  onRetry?: (info: ProviderRetryInfo) => void;
}): Promise<ConversationCompact> {
  const outcome = await runPortableCompaction({
    rootDir: options.rootDir,
    sessionId: options.sessionId,
    engine: options.engine,
    providerSelection: options.providerSelection,
    generation: options.generation,
    trigger: "manual",
    phase: "manual",
    reason: "requested",
    instructions: options.instructions,
    signal: options.signal,
    onRetry: options.onRetry,
  });
  if (outcome.kind === "nothing-to-compact") throw new Error(ERROR_NOTHING_TO_COMPACT);
  if (outcome.kind === "cancelled") throw outcome.error;
  if (outcome.kind === "failed") throw outcome.error;
  return {
    snapshot: outcome.snapshot,
    summary: outcome.summary,
    parentUuid: outcome.checkpointUuid,
    messagesSummarized: outcome.messagesSummarized,
  };
}

export async function compactConversationFromPoint(options: {
  rootDir: string;
  sessionId: string;
  point: CompactPoint;
  engine: EngineId;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  instructions?: string;
  signal?: AbortSignal;
  onRetry?: (info: ProviderRetryInfo) => void;
}): Promise<ConversationCompactFromPoint> {
  const full = await loadSessionSnapshot(options.rootDir, options.sessionId);
  assertNoPendingInteraction(full);
  const kept = await loadSessionSnapshot(options.rootDir, options.sessionId, { headUuid: options.point.parentUuid });
  const messagesSummarized = Math.max(1, full.messages.length - kept.messages.length);
  const pivotInstruction = `${PARTIAL_COMPACT_PROMPT}\n\nSelected pivot user message:\n${options.point.content}`;
  const summary = await generateSummary({
    rootDir: options.rootDir,
    sessionId: options.sessionId,
    engine: options.engine,
    providerSelection: options.providerSelection,
    generation: options.generation,
    messages: full.messages,
    prompt: compactPrompt(pivotInstruction, options.instructions),
    signal: options.signal,
    onRetry: options.onRetry,
  });

  const session = await createSessionStore(options.rootDir, options.sessionId, { parentUuid: options.point.parentUuid });
  await session.append({
    role: "system",
    content: "Conversation compacted from selected message.",
    metadata: {
      kind: COMPACT_BOUNDARY_KIND,
      engine: options.engine,
      messagesSummarized,
      pivotMessageId: options.point.uuid,
    },
  });
  const summaryRecord = await session.append({
    role: "user",
    content: `[conversation summary]\n${summary}`,
    metadata: {
      kind: COMPACT_SUMMARY_KIND,
      engine: options.engine,
      messagesSummarized,
      pivotMessageId: options.point.uuid,
    },
  });
  const snapshot = await loadSessionSnapshot(options.rootDir, options.sessionId, { headUuid: summaryRecord.uuid });
  return {
    snapshot,
    prompt: options.point.content,
    summary,
    parentUuid: summaryRecord.uuid,
    messagesSummarized,
  };
}

async function generateSummary(options: {
  rootDir: string;
  sessionId: string;
  engine: EngineId;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  messages: ResumedMessage[];
  prompt: string;
  signal?: AbortSignal;
  onRetry?: (info: ProviderRetryInfo) => void;
}): Promise<string> {
  const config = await loadConfigForSelection(options.providerSelection);
  const proxyPolicy = await resolveProviderProxyPolicy();
  const provider = createProvider(config, { sessionId: options.sessionId, proxyPolicy });
  const profile = await loadEngineProfile(options.engine, options.rootDir);
  const enginePrompt = composeSystemPrompt(await loadPromptBundle(profile, options.rootDir));
  const systemPrompt = (
    await composeSystemPromptWithInstructions(options.engine, enginePrompt, options.rootDir)
  ).systemPrompt;
  const request: VesicleRequest = {
    id: options.sessionId,
    model: { provider: config.providerId, model: config.model },
    system: [systemPrompt],
    messages: [
      ...options.messages.map(toVesicleMessage),
      { role: "user", content: `${NO_TOOLS_COMPACT_PREAMBLE}\n\n${options.prompt}` },
    ],
    generation: options.generation,
    signal: options.signal,
    onRetry: options.onRetry,
  };
  const response = await complete(provider, request);
  const summary = formatCompactSummary(response.content);
  if (!summary) throw new Error("Failed to generate conversation summary.");
  return summary;
}

async function complete(provider: ReturnType<typeof createProvider>, request: VesicleRequest): Promise<VesicleResponse> {
  if (!provider.stream) return provider.complete(request);
  let response: VesicleResponse | undefined;
  for await (const event of provider.stream(request)) {
    if (event.type === "complete") response = event.response;
  }
  if (!response) throw new Error("Provider stream ended without a compact summary.");
  return response;
}

function compactPrompt(base: string, instructions: string | undefined): string {
  const trimmed = instructions?.trim();
  return trimmed ? `${base}\n\nAdditional summary instructions:\n${trimmed}` : base;
}

function assertNoPendingInteraction(snapshot: SessionSnapshot): void {
  if (
    snapshot.pendingGate
    || snapshot.pendingEngineSwitch
    || snapshot.pendingUserQuestion
    || snapshot.pendingPermission
    || snapshot.pendingDelegationRetry
    || snapshot.pendingDelegationDecisionRecovery
    || snapshot.pendingQualityRewrite
    || snapshot.pendingQualityDecision
  ) {
    throw new Error(ERROR_PENDING_INTERACTION);
  }
}
