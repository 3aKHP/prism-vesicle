import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { loadEngineProfile, type EngineId } from "../engine/profile";
import { composeSystemPromptWithInstructions } from "../instructions";
import { composeSystemPrompt, loadPromptBundle } from "../prompt/loader";
import { createSessionStore, loadSessionSnapshot, type ResumedMessage, type SessionRecord, type SessionSnapshot } from "../session/store";

export const COMPACT_BOUNDARY_KIND = "compact-boundary";
export const COMPACT_SUMMARY_KIND = "compact-summary";

export const ERROR_NOT_ENOUGH_MESSAGES_TO_COMPACT = "Not enough messages to compact.";
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

const FULL_COMPACT_PROMPT = `
Your task is to create a detailed summary of the conversation so far so a
future model can continue the work without the removed turns. Preserve the
user's explicit intent, project decisions, relevant files and artifacts, tool
outcomes, unresolved issues, current workflow state, and the next useful step.

In <analysis>, check the conversation chronologically for:
1. User requests and corrections.
2. Important technical concepts and architecture decisions.
3. Files, commands, generated artifacts, and tool outcomes.
4. Errors encountered and how they were fixed.
5. Pending tasks and the exact current state.

In <summary>, provide a compact but specific continuation brief. Include only
facts that are useful for continuing the session.
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
}): Promise<ConversationCompact> {
  const full = await loadSessionSnapshot(options.rootDir, options.sessionId);
  assertNoPendingInteraction(full);
  const compactableCount = countCompactableMessages(full.messages);
  if (compactableCount < 2) throw new Error(ERROR_NOT_ENOUGH_MESSAGES_TO_COMPACT);

  const summary = await generateSummary({
    rootDir: options.rootDir,
    sessionId: options.sessionId,
    engine: options.engine,
    providerSelection: options.providerSelection,
    generation: options.generation,
    messages: full.messages,
    prompt: compactPrompt(FULL_COMPACT_PROMPT, options.instructions),
    signal: options.signal,
  });

  const compactRoot = compactRootParent(full.records);
  const session = await createSessionStore(options.rootDir, options.sessionId, { parentUuid: compactRoot });
  await session.append({
    role: "system",
    content: "Conversation compacted.",
    metadata: {
      kind: COMPACT_BOUNDARY_KIND,
      engine: options.engine,
      messagesSummarized: compactableCount,
    },
  });
  const summaryRecord = await session.append({
    role: "user",
    content: `[conversation summary]\n${summary}`,
    metadata: {
      kind: COMPACT_SUMMARY_KIND,
      engine: options.engine,
      messagesSummarized: compactableCount,
    },
  });
  const snapshot = await loadSessionSnapshot(options.rootDir, options.sessionId, { headUuid: summaryRecord.uuid });
  return {
    snapshot,
    summary,
    parentUuid: summaryRecord.uuid,
    messagesSummarized: compactableCount,
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

export function formatCompactSummary(content: string): string {
  const withoutAnalysis = content.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();
  const match = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i);
  return (match?.[1] ?? withoutAnalysis).trim();
}

function assertNoPendingInteraction(snapshot: SessionSnapshot): void {
  if (snapshot.pendingGate || snapshot.pendingEngineSwitch || snapshot.pendingUserQuestion) {
    throw new Error(ERROR_PENDING_INTERACTION);
  }
}

function countCompactableMessages(messages: ResumedMessage[]): number {
  return messages.filter((message) => message.kind !== COMPACT_SUMMARY_KIND).length;
}

function compactRootParent(records: SessionRecord[]): string | null {
  return records.find((record) => record.role === "system")?.uuid ?? null;
}
