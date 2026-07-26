import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { ProviderRetryInfo, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { loadEngineProfile, type EngineId } from "../engine/profile";
import { composeSystemPromptWithInstructions } from "../instructions";
import { composeSystemPrompt, loadPromptBundle } from "../prompt/loader";
import { createSessionStore, loadSessionSnapshot, type ResumedMessage, type SessionSnapshot } from "../session/store";
import { selectReplacement } from "./replacement-builder";
import { formatCompactSummary, generatePortableSummary, toVesicleMessage } from "./summary-generator";
import { installCompactCheckpoint } from "./checkpoint-installer";

export { formatCompactSummary };

export const COMPACT_BOUNDARY_KIND = "compact-boundary";
export const COMPACT_SUMMARY_KIND = "compact-summary";

export const ERROR_NOTHING_TO_COMPACT = "Nothing left to compact; the newest complete turn is already the retained tail.";
export const ERROR_NOT_ENOUGH_MESSAGES_TO_COMPACT = ERROR_NOTHING_TO_COMPACT;
export const ERROR_PENDING_INTERACTION = "Resolve the pending gate, engine switch, or question before compacting.";

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
    }
  | { kind: "nothing-to-compact" }
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
    return { kind: "failed", error };
  }

  const session = await createSessionStore(options.rootDir, options.sessionId);
  const installed = await installCompactCheckpoint({
    rootDir: options.rootDir,
    sessionId: options.sessionId,
    session,
    selection,
    summary,
    trigger: options.trigger,
    phase: options.phase,
    reason: options.reason,
    createdWith: { providerId: config.providerId, model: config.model, engine: options.engine },
    accounting: {
      ...(config.limits?.contextWindow ? { contextWindow: config.limits.contextWindow } : {}),
      beforeSource: "unknown",
    },
  });

  const snapshot = await loadSessionSnapshot(options.rootDir, options.sessionId, { headUuid: installed.checkpointUuid });
  const messagesSummarized = selection.evictedRecords.filter((record) => record.role !== "system").length;
  const retainedUnits = selection.retainedRecords.filter((record) => record.role !== "system").length;
  return {
    kind: "completed",
    snapshot,
    summary,
    checkpointUuid: installed.checkpointUuid,
    messagesSummarized,
    retainedUnits,
    ...(config.limits?.contextWindow ? { contextWindow: config.limits.contextWindow } : {}),
  };
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
  const provider = createProvider(config);
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
  if (snapshot.pendingGate || snapshot.pendingEngineSwitch || snapshot.pendingUserQuestion) {
    throw new Error(ERROR_PENDING_INTERACTION);
  }
}
