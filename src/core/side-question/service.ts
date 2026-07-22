// `/btw` side-question provider service: one tool-free streaming completion
// over a frozen copy of the current conversation context. The service owns no
// session, tool, gate, validator, or persistence surface — it sends exactly
// one provider request and returns the text. See
// `dev/docs/working/BTW_COMMAND_IMPLEMENTATION_GUIDE.md` for the contract.

import { loadConfigForSelection } from "../../config/providers";
import type { ProviderSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { EngineId } from "../engine/profile";
import { mergeGeneration } from "../agent-loop/generation";
import { resolveProjectHarnessRuntime, requireProjectHarnessRuntime } from "../harness/activation";
import { loadEngineAssetRuntime } from "../runtime/engine-assets";
import { loadSessionSnapshot, type ResumedMessage } from "../session/store";
import type { ReasoningTier, ResponseUsage, VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { materializeMessageImages } from "../attachments/store";
import { createAssetResolver } from "../runtime/assets";
import { cloneSideQuestionMessages, type SideQuestionContextSnapshot } from "./types";

const SIDE_QUESTION_PROMPT_PATH = "assets/prompts/shared/side-question.md";

export async function askSideQuestion(options: {
  rootDir: string;
  context: SideQuestionContextSnapshot;
  question: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}): Promise<{ content: string; usage?: ResponseUsage }> {
  const { context } = options;
  const config = await loadConfigForSelection(context.providerSelection);
  const provider = createProvider(config);
  const sidePrompt = await loadSideQuestionPrompt(options.rootDir);
  const messages = await buildSideMessages(options.rootDir, context);

  const request: VesicleRequest = {
    id: `${context.sessionId}:btw:${crypto.randomUUID()}`,
    model: { provider: config.providerId, model: config.model },
    system: [context.systemPrompt, sidePrompt],
    messages: [...messages, { role: "user", content: options.question }],
    ...(context.generation ? { generation: context.generation } : {}),
    signal: options.signal,
  };

  const response = provider.stream
    ? await streamSideResponse(provider, request, options.onDelta)
    : await provider.complete(request);

  // A tool-call-only or empty response is an error: `/btw` never enters a tool
  // loop and must produce one text answer.
  if (!response.content.trim()) {
    throw new Error("The side question did not return a text answer.");
  }
  return { content: response.content, ...(response.usage ? { usage: response.usage } : {}) };
}

async function loadSideQuestionPrompt(rootDir: string): Promise<string> {
  const resolver = createAssetResolver(rootDir);
  return (await resolver.readText(SIDE_QUESTION_PROMPT_PATH)).trim();
}

async function buildSideMessages(
  rootDir: string,
  context: SideQuestionContextSnapshot,
): Promise<VesicleMessage[]> {
  if (!context.visionEnabled) {
    // Non-vision models never receive images; drop any references defensively.
    return context.messages.map((message) => {
      if (!message.images || message.images.length === 0) return message;
      const { images: _images, ...withoutImages } = message;
      return withoutImages;
    });
  }
  return Promise.all(
    context.messages.map(async (message) => {
      if (!message.images || message.images.length === 0) return message;
      const images = await materializeMessageImages(rootDir, message.images);
      return { ...message, ...(images ? { images } : {}) };
    }),
  );
}

async function streamSideResponse(
  provider: ReturnType<typeof createProvider>,
  request: VesicleRequest,
  onDelta?: (delta: string) => void,
): Promise<VesicleResponse> {
  let response: VesicleResponse | undefined;
  for await (const event of provider.stream!(request)) {
    if (event.type === "content_delta") onDelta?.(event.delta);
    else if (event.type === "complete") response = event.response;
  }
  if (!response) throw new Error("Provider stream ended without a final side response.");
  return response;
}

/**
 * Reconstruct a provider-valid side-question snapshot for a resumed session,
 * mirroring `bootstrapTurn`'s pure Engine asset resolution and frozen Stage
 * bootstrap context without persisting a user record or creating a checkpoint.
 * Returns `undefined` when the session cannot be read, so `/btw` falls back to
 * its "available after the session starts" message instead of erroring.
 */
export async function resolveSideQuestionSnapshot(options: {
  rootDir: string;
  sessionId: string;
  engine: EngineId;
  providerSelection?: Partial<ProviderSelection>;
  reasoningTier?: ReasoningTier;
}): Promise<SideQuestionContextSnapshot | undefined> {
  const config = await loadConfigForSelection(options.providerSelection);
  const projectHarness = await resolveProjectHarnessRuntime(options.rootDir)
    .then((runtime) => (runtime ? requireProjectHarnessRuntime(runtime) : undefined))
    .catch(() => undefined);
  const engineAssets = await loadEngineAssetRuntime(
    options.engine,
    options.rootDir,
    projectHarness?.assets ? { resolver: projectHarness.assets } : {},
  );
  const snapshot = await loadSessionSnapshot(options.rootDir, options.sessionId, {
    synthesizeDanglingToolResults: false,
  }).catch(() => undefined);
  if (!snapshot) return undefined;
  let systemPrompt = engineAssets.systemPrompt;
  if (options.engine === "stage" && snapshot.stageBootstrap) {
    systemPrompt = `${systemPrompt}\n\n${snapshot.stageBootstrap.renderedCharacterContext}`;
  }
  // Merge model generation defaults with the active reasoning tier, matching
  // bootstrapTurn() so resumed side context keeps temperature/maxTokens.
  const generation = mergeGeneration(config.generation, reasoningTierToGeneration(options.reasoningTier));
  return {
    sessionId: options.sessionId,
    engine: options.engine,
    providerSelection: { provider: config.providerId, model: config.model },
    ...(generation ? { generation } : {}),
    visionEnabled: config.capabilities?.vision === true,
    systemPrompt,
    messages: cloneSideQuestionMessages(snapshot.messages.map(toVesicleMessage)),
  };
}

function reasoningTierToGeneration(reasoningTier?: ReasoningTier): VesicleRequest["generation"] | undefined {
  return reasoningTier ? { reasoningTier } : undefined;
}

function toVesicleMessage(message: ResumedMessage): VesicleMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) } : {}),
    ...(message.images ? { images: message.images.map(({ data: _data, ...image }) => image) } : {}),
  };
}
