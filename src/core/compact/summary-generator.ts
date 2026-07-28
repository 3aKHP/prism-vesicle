import type { ProviderSelection } from "../../config/providers";
import { loadConfigForSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { ProviderRetryInfo, VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { loadEngineProfile, type EngineId } from "../engine/profile";
import { composeSystemPromptWithInstructions } from "../instructions";
import { composeSystemPrompt, loadPromptBundle } from "../prompt/loader";
import { projectSessionHistory, type ResumedMessage, type SessionRecord } from "../session/store";

const NO_TOOLS_COMPACT_PREAMBLE = `
CRITICAL: Respond with TEXT ONLY. Do NOT call tools.

- You already have the context to summarize in the conversation above.
- Do not ask follow-up questions.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
`.trim();

const FULL_COMPACT_PROMPT = `
Your task is to create a detailed summary of the conversation so far so a future
model can continue the work without the removed turns. Preserve the user's
explicit intent, project decisions, relevant files and artifacts, tool outcomes,
unresolved issues, current workflow state, and the next useful step.

In <analysis>, check the conversation chronologically for:
1. User requests and corrections.
2. Important technical concepts and architecture decisions.
3. Files, commands, generated artifacts, and tool outcomes.
4. Errors encountered and how they were fixed.
5. Pending tasks and the exact current state.

In <summary>, provide a compact but specific continuation brief. Include only
facts that are useful for continuing the session.
`.trim();

export type GenerateSummaryOptions = {
  rootDir: string;
  sessionId: string;
  engine: EngineId;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  /** Records whose provider-visible content the summary must cover. */
  evictedRecords: SessionRecord[];
  /** Prior portable summary to merge in, so a retained tail is never re-summarized. */
  previousSummary?: string;
  instructions?: string;
  signal?: AbortSignal;
  onRetry?: (info: ProviderRetryInfo) => void;
};

export async function generatePortableSummary(options: GenerateSummaryOptions): Promise<string> {
  const messages = projectSessionHistory(options.evictedRecords).messages;
  const prompt = compactPrompt(FULL_COMPACT_PROMPT, options.instructions, options.previousSummary);
  const config = await loadConfigForSelection(options.providerSelection);
  const provider = createProvider(config);
  const profile = await loadEngineProfile(options.engine, options.rootDir);
  const enginePrompt = composeSystemPrompt(await loadPromptBundle(profile, options.rootDir));
  const systemPrompt = (await composeSystemPromptWithInstructions(options.engine, enginePrompt, options.rootDir)).systemPrompt;
  const request: VesicleRequest = {
    id: options.sessionId,
    model: { provider: config.providerId, model: config.model },
    system: [systemPrompt],
    messages: [
      ...messages.map(toVesicleMessage),
      { role: "user", content: `${NO_TOOLS_COMPACT_PREAMBLE}\n\n${prompt}` },
    ],
    generation: options.generation,
    signal: options.signal,
    onRetry: options.onRetry,
  };
  const response = await completeProviderRequest(provider, request);
  const summary = formatCompactSummary(response.content);
  if (!summary) throw new Error("Failed to generate conversation summary.");
  return summary;
}

async function completeProviderRequest(provider: ReturnType<typeof createProvider>, request: VesicleRequest): Promise<VesicleResponse> {
  if (!provider.stream) return provider.complete(request);
  let response: VesicleResponse | undefined;
  for await (const event of provider.stream(request)) {
    if (event.type === "complete") response = event.response;
  }
  if (!response) throw new Error("Provider stream ended without a compact summary.");
  return response;
}

function compactPrompt(base: string, instructions: string | undefined, previousSummary: string | undefined): string {
  const parts = [base];
  const trimmedInstructions = instructions?.trim();
  if (trimmedInstructions) parts.push(`Additional summary instructions:\n${trimmedInstructions}`);
  if (previousSummary && previousSummary.trim()) {
    parts.push(
      `A previous compaction already produced the summary below. Merge it with the newly evicted turns so the result is one continuous brief. Do not repeat verbatim what is already in it, and do not summarize any turn that is still retained verbatim after this compaction.`,
      `Previous summary:\n${previousSummary.trim()}`,
    );
  }
  return parts.join("\n\n");
}

export function toVesicleMessage(message: ResumedMessage): VesicleMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
    ...(message.thinkingBlocks ? { thinkingBlocks: message.thinkingBlocks } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.images?.length ? { images: message.images } : {}),
  };
}

export function formatCompactSummary(content: string): string {
  const withoutAnalysis = content.replace(/<analysis>[\s\S]*?<\/analysis>/i, "").trim();
  const match = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i);
  return (match?.[1] ?? withoutAnalysis).trim();
}
