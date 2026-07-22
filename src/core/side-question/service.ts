// `/btw` side-question provider service: one tool-free streaming completion.
// The request has exactly one system authority (the side-question prompt) and
// one user message — a host-rendered reference packet that quotes the parent
// Engine prompt, conversation, and tool results as inert reference data. The
// service owns no session, tool, gate, validator, or persistence surface. See
// `dev/docs/working/BTW_SINGLE_SYSTEM_REFERENCE_PROJECTION_GUIDE.md`.

import { loadConfigForSelection } from "../../config/providers";
import type { ProviderSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { EngineId } from "../engine/profile";
import { mergeGeneration } from "../agent-loop/generation";
import { resolveProjectHarnessRuntime, requireProjectHarnessRuntime } from "../harness/activation";
import { loadEngineAssetRuntime } from "../runtime/engine-assets";
import { loadSessionSnapshot, type ResumedMessage } from "../session/store";
import type { ReasoningTier, ResponseUsage, VesicleImageAttachment, VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { materializeMessageImages } from "../attachments/store";
import { createAssetResolver } from "../runtime/assets";
import { cloneSideQuestionMessages, type SideQuestionContextSnapshot } from "./types";
import { projectSideQuestionReference } from "./reference";

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
  const projection = projectSideQuestionReference(context, options.question);
  const images = context.visionEnabled ? await materializeReferenceImages(options.rootDir, projection.images) : [];

  const request: VesicleRequest = {
    id: `${context.sessionId}:btw:${crypto.randomUUID()}`,
    model: { provider: config.providerId, model: config.model },
    system: [sidePrompt],
    messages: [{ role: "user", content: projection.content, ...(images.length > 0 ? { images } : {}) }],
    ...(context.generation ? { generation: context.generation } : {}),
    signal: options.signal,
  };

  const response = provider.stream
    ? await streamSideResponse(provider, request, options.onDelta)
    : await provider.complete(request);

  // `/btw` declares no tools and must never execute one. Reject any structured
  // tool call (including a mixed text-plus-tool response) before the empty-text
  // check so a provider that returns both is still treated as a failure.
  if (response.toolCalls?.length) {
    throw new Error("The side question attempted to call a tool.");
  }
  if (!response.content.trim()) {
    throw new Error("The side question did not return a text answer.");
  }
  return { content: response.content, ...(response.usage ? { usage: response.usage } : {}) };
}

async function loadSideQuestionPrompt(rootDir: string): Promise<string> {
  const resolver = createAssetResolver(rootDir);
  return (await resolver.readText(SIDE_QUESTION_PROMPT_PATH)).trim();
}

async function materializeReferenceImages(
  rootDir: string,
  images: VesicleImageAttachment[],
): Promise<VesicleImageAttachment[]> {
  if (images.length === 0) return [];
  const materialized = await materializeMessageImages(rootDir, images);
  return materialized ?? [];
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
 *
 * Returns `undefined` only when the session record cannot be read; provider
 * config, harness, or engine-asset load failures propagate. Both callers wrap
 * the call with `.catch(() => undefined)` so a load failure degrades to
 * "available after the session starts" rather than crashing the TUI.
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
  let engineSystemPrompt = engineAssets.systemPrompt;
  if (options.engine === "stage" && snapshot.stageBootstrap) {
    engineSystemPrompt = `${engineSystemPrompt}\n\n${snapshot.stageBootstrap.renderedCharacterContext}`;
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
    engineSystemPrompt,
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
