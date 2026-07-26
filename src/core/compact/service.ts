import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { ProviderRetryInfo, VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { loadEngineProfile, type EngineId } from "../engine/profile";
import { composeSystemPromptWithInstructions } from "../instructions";
import { composeSystemPrompt, loadPromptBundle } from "../prompt/loader";
import { createSessionStore, loadSessionSnapshot, type ResumedMessage, type SessionSnapshot } from "../session/store";
import { selectReplacement } from "./replacement-builder";
import { formatCompactSummary, generatePortableSummary } from "./summary-generator";
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
  const full = await loadSessionSnapshot(options.rootDir, options.sessionId);
  assertNoPendingInteraction(full);

  const config = await loadConfigForSelection(options.providerSelection);
  const selection = selectReplacement(full.records, { contextWindow: config.limits?.contextWindow });
  if (!selection) throw new Error(ERROR_NOTHING_TO_COMPACT);

  // Transaction boundary (plan §3): produce + validate the summary first; the
  // installer then builds + validates the replacement and appends one record.
  // A provider failure, malformed payload, or append error leaves the former
  // head active and usable — nothing is installed in memory.
  const summary = await generatePortableSummary({
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

  const session = await createSessionStore(options.rootDir, options.sessionId);
  const installed = await installCompactCheckpoint({
    rootDir: options.rootDir,
    sessionId: options.sessionId,
    session,
    selection,
    summary,
    trigger: "manual",
    phase: "manual",
    reason: "requested",
    createdWith: { providerId: config.providerId, model: config.model, engine: options.engine },
    accounting: {
      ...(config.limits?.contextWindow ? { contextWindow: config.limits.contextWindow } : {}),
      beforeSource: "unknown",
    },
  });

  const snapshot = await loadSessionSnapshot(options.rootDir, options.sessionId, { headUuid: installed.checkpointUuid });
  const messagesSummarized = selection.evictedRecords.filter((record) => record.role !== "system").length;
  return {
    snapshot,
    summary,
    parentUuid: installed.checkpointUuid,
    messagesSummarized,
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

function toVesicleMessage(message: ResumedMessage): VesicleMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.thinkingBlocks ? { thinkingBlocks: message.thinkingBlocks } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
  };
}

function assertNoPendingInteraction(snapshot: SessionSnapshot): void {
  if (snapshot.pendingGate || snapshot.pendingEngineSwitch || snapshot.pendingUserQuestion) {
    throw new Error(ERROR_PENDING_INTERACTION);
  }
}
