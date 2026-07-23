import type { ResponseUsage, VesicleMessage, VesicleResponse } from "../../providers/shared/types";
import type { PermissionDecisionSource, PermissionMode } from "../permissions";
import {
  evaluateBoundQuality,
  evaluateBoundQualityTargets,
  qualityArtifactTargetFromResult,
  qualityCandidateParts,
  qualityModeForAgent,
  readQualityArtifactTargets,
  recordQualityEvent,
  upsertQualityArtifactTarget,
  type QualityArtifactTarget,
} from "../quality";
import type { SessionStore } from "../session/store";
import type { ToolCall, ToolResult } from "../tools";
import type { AgentInvocationContext, AgentRunOutput } from "./types";

export type ChildRunState = {
  messages: VesicleMessage[];
  usage?: ResponseUsage;
  toolUses: number;
  qualityProseParts: string[];
  qualityTargets: QualityArtifactTarget[];
};

export function createChildRunState(messages: VesicleMessage[]): ChildRunState {
  return {
    messages,
    toolUses: 0,
    qualityProseParts: [],
    qualityTargets: [],
  };
}

export async function appendChildParentMessages(
  state: ChildRunState,
  pending: string[],
  session: SessionStore,
  runId: string,
  handle: string,
): Promise<number> {
  for (const message of pending) {
    const content = `[message from parent Engine]\n${message}`;
    state.messages.push({ role: "user", content });
    await session.append({ role: "user", content, metadata: { kind: "subagent-parent-message", runId, handle } });
  }
  return pending.length;
}

export async function recordChildResponse(
  state: ChildRunState,
  response: VesicleResponse,
  session: SessionStore,
  runId: string,
  handle: string,
): Promise<ToolCall[]> {
  state.usage = addUsage(state.usage, response.usage);
  const calls = response.toolCalls ?? [];
  if (calls.length === 0) state.qualityProseParts.push(...qualityCandidateParts(response));
  state.toolUses += calls.length;
  state.messages.push({
    role: "assistant",
    content: response.content,
    ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
    ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
    ...(calls.length > 0 ? { toolCalls: calls } : {}),
  });
  await session.append({
    role: "assistant",
    content: response.content,
    metadata: {
      kind: "subagent-response",
      runId,
      handle,
      providerResponseId: response.id,
      ...(response.usage ? { usage: response.usage } : {}),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    },
  });
  return calls;
}

export async function recordChildToolResult(
  state: ChildRunState,
  {
    call,
    result,
    session,
    runId,
    handle,
    profileId,
    permissionMode,
    decisionSource,
  }: {
    call: ToolCall;
    result: ToolResult;
    session: SessionStore;
    runId: string;
    handle: string;
    profileId: string;
    permissionMode: PermissionMode;
    decisionSource: PermissionDecisionSource;
  },
): Promise<void> {
  const content = JSON.stringify({ ok: result.ok, result: result.content });
  state.messages.push({ role: "tool", toolCallId: call.id, content, ...(result.images ? { images: result.images } : {}) });
  await session.append({
    role: "tool",
    content,
    metadata: {
      kind: "subagent-tool-result",
      runId,
      handle,
      name: call.name,
      ok: result.ok,
      toolCallId: call.id,
      permissionMode,
      decisionSource,
      ...(result.fileEvent ? { fileEvent: result.fileEvent } : {}),
      ...(result.webEvent ? { webEvent: result.webEvent } : {}),
      ...(result.mcpEvent ? { mcpEvent: result.mcpEvent } : {}),
    },
  });
  const qualityTarget = qualityArtifactTargetFromResult(profileId, result);
  if (qualityTarget) upsertQualityArtifactTarget(state.qualityTargets, qualityTarget);
}

export async function completeChildRun(
  state: ChildRunState,
  response: VesicleResponse,
  session: SessionStore,
  profileId: string,
  invocation: AgentInvocationContext,
  onProgress: (text: string) => void,
): Promise<AgentRunOutput> {
  const qualityRuntime = invocation.harness?.quality;
  const qualityMode = qualityModeForAgent(qualityRuntime, profileId);
  if (qualityRuntime && qualityMode === "observe") {
    onProgress("checking prose quality");
    const quality = state.qualityTargets.length > 0
      ? evaluateBoundQualityTargets({
        runtime: qualityRuntime,
        producer: profileId,
        mode: qualityMode,
        targets: await readQualityArtifactTargets(invocation.rootDir, state.qualityTargets),
        attempt: 0,
        state: { attempts: 0, rejectedHashes: new Set(), targets: state.qualityTargets },
        usage: response.usage,
      })
      : evaluateBoundQuality({
        runtime: qualityRuntime,
        producer: profileId,
        mode: qualityMode,
        content: state.qualityProseParts.join("\n\n"),
        attempt: 0,
        state: { attempts: 0, rejectedHashes: new Set() },
        usage: response.usage,
      });
    if (quality) await recordQualityEvent(session, quality);
  }
  return {
    content: response.content,
    childSessionId: session.sessionId,
    ...(state.usage ? { usage: state.usage } : {}),
    ...(state.toolUses > 0 ? { toolUses: state.toolUses } : {}),
  };
}

function addUsage(total: ResponseUsage | undefined, next: ResponseUsage | undefined): ResponseUsage | undefined {
  if (!next) return total;
  const result: ResponseUsage = { ...(total ?? {}) };
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadInputTokens",
    "cacheWriteInputTokens",
    "cacheHitInputTokens",
    "cacheMissInputTokens",
    "reasoningTokens",
    "effectiveTokens",
  ] as const) {
    if (next[key] !== undefined) result[key] = (result[key] ?? 0) + next[key];
  }
  if (next.contextInputTokens !== undefined) result.contextInputTokens = next.contextInputTokens;
  return result;
}
