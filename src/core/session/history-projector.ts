import { engineIds, type EngineId } from "../engine/profile";
import { parseImageAttachments } from "../attachments/store";
import { parseAssetFingerprint, type AssetFingerprint } from "../runtime/assets";
import { parseHarnessRuntimeIdentity } from "../harness/activation";
import type { HarnessRuntimeIdentity } from "../harness/driver";
import { reasoningTiers, type ProviderThinkingBlock, type ReasoningTier, type ResponseUsage } from "../../providers/shared/types";
import type { ProviderSelection } from "../../config/providers";
import type { FileToolEvent, McpToolEvent, ProcessToolEvent, WebToolEvent } from "../tools";
import type { PermissionMode } from "../permissions";
import type { ReasoningDisplayMode, ResumedMessage } from "./store";
import type { ResumedToolCall, SessionRecord } from "./record-model";

export type HistoryProjection = {
  messages: ResumedMessage[];
  engine?: EngineId;
  providerSelection?: ProviderSelection;
  reasoningTier?: ReasoningTier;
  reasoningDisplayMode?: ReasoningDisplayMode;
  permissionMode?: PermissionMode;
  assets?: AssetFingerprint;
  harness?: HarnessRuntimeIdentity;
};

/**
 * Host-only marker appended after a user turn whose provider round never reached
 * a successful assistant reply. `projectSessionHistory` reads it as the cue to
 * drop the failed turn's input from provider-visible history so a resumed or
 * resent turn cannot send consecutive same-role user messages (Anthropic
 * Messages requires strict user/assistant alternation). The failed user record
 * stays in `records` for the UI transcript and `/rewind`.
 */
export const FAILED_TURN_KIND = "failed-turn";

/**
 * User-role record kinds that act as a completed-operation boundary: a failed
 * turn's input is dropped only down to one of these. A `/compact` summary is the
 * sole such boundary — it is the terminal output of a finished compaction, never
 * the input to a round that can fail. Every other user-role record (a prompt, a
 * queued message, background-process results, a SubAgent delivery, an engine
 * handoff, a gate/user-question resolution, or a quality-rewrite feedback) is
 * the failed round's own input and must be dropped, otherwise resume/resend
 * emits consecutive same-role user messages. (SubAgent results are re-delivered
 * via the paused delivery; background-process results are re-drained.)
 */
const failedTurnBoundaryKinds = new Set(["compact-summary"]);

/**
 * Remove the trailing user messages that belong to a failed turn. A failed turn
 * appends no assistant reply, so its input is a run of trailing user records
 * (the prompt plus any host-injected user context such as background-process
 * results or a quality-rewrite feedback). A completed-operation boundary
 * (`compact-summary`) is preserved.
 */
function dropFailedTurnInput(messages: ResumedMessage[]): void {
  while (messages.length > 0) {
    const last = messages[messages.length - 1]!;
    if (last.role !== "user") break;
    if (last.kind && failedTurnBoundaryKinds.has(last.kind)) break;
    messages.pop();
  }
}

/** Projects durable records into provider history plus host-only session preferences. */
export function projectSessionHistory(records: SessionRecord[]): HistoryProjection {
  const messages: ResumedMessage[] = [];
  let skippedFirstSystem = false;
  let engine: EngineId | undefined;
  let providerSelection: ProviderSelection | undefined;
  let reasoningTier: ReasoningTier | undefined;
  let reasoningDisplayMode: ReasoningDisplayMode | undefined;
  let permissionMode: PermissionMode | undefined;
  let assets: AssetFingerprint | undefined;
  let harness: HarnessRuntimeIdentity | undefined;

  for (const record of records) {
    if (record.metadata && Object.hasOwn(record.metadata, "engine")) {
      const nextEngine = readEngineId(record.metadata.engine);
      if (nextEngine) engine = nextEngine;
    }
    const providerId = record.metadata?.providerId;
    const model = record.metadata?.model;
    if (typeof providerId === "string" && typeof model === "string") providerSelection = { provider: providerId, model };
    if (record.metadata && Object.hasOwn(record.metadata, "reasoningTier")) reasoningTier = readReasoningTier(record.metadata.reasoningTier);
    if (record.metadata && Object.hasOwn(record.metadata, "reasoningDisplayMode")) reasoningDisplayMode = readReasoningDisplayMode(record.metadata.reasoningDisplayMode);
    if (isPermissionMode(record.metadata?.permissionMode)) permissionMode = record.metadata!.permissionMode as PermissionMode;

    if (record.role === "system") {
      if (!skippedFirstSystem) {
        assets = parseAssetFingerprint(record.metadata?.assets);
        harness = readHarnessRuntimeIdentity(record.metadata?.harness);
        skippedFirstSystem = true;
      }
      if (record.metadata?.kind === FAILED_TURN_KIND) {
        dropFailedTurnInput(messages);
      }
      continue;
    }

    if (record.role === "assistant") {
      const toolCalls = record.metadata?.toolCalls as ResumedToolCall[] | undefined;
      const reasoningContent = record.metadata?.reasoningContent as string | undefined;
      const thinkingBlocks = readThinkingBlocks(record.metadata?.thinkingBlocks);
      const messageEngine = readEngineId(record.metadata?.engine);
      const messageModel = typeof record.metadata?.model === "string" ? record.metadata.model : undefined;
      const usage = readResponseUsage(record.metadata?.usage);
      const kind = typeof record.metadata?.kind === "string" ? record.metadata.kind : undefined;
      messages.push({ recordUuid: record.uuid, role: "assistant", content: record.content, ...(messageEngine ? { engine: messageEngine } : {}), ...(messageModel ? { model: messageModel } : {}), ...(reasoningContent ? { reasoningContent } : {}), ...(thinkingBlocks ? { thinkingBlocks } : {}), ...(toolCalls ? { toolCalls } : {}), ...(usage ? { usage } : {}), ...(kind ? { kind } : {}) });
      continue;
    }

    if (record.role === "user") {
      const kind = typeof record.metadata?.kind === "string" ? record.metadata.kind : undefined;
      const usage = readResponseUsage(record.metadata?.usage);
      const images = parseImageAttachments(record.metadata?.images);
      messages.push({ role: "user", content: record.content, ...(kind ? { kind } : {}), ...(usage ? { usage } : {}), ...(images ? { images } : {}) });
      continue;
    }

    const toolCallId = record.metadata?.toolCallId as string | undefined;
    const toolOk = record.metadata?.ok as boolean | undefined;
    const toolFileEvent = record.metadata?.fileEvent as FileToolEvent | undefined;
    const toolWebEvent = record.metadata?.webEvent as WebToolEvent | undefined;
    const toolMcpEvent = record.metadata?.mcpEvent as McpToolEvent | undefined;
    const toolProcessEvent = record.metadata?.processEvent as ProcessToolEvent | undefined;
    const images = parseImageAttachments(record.metadata?.images);
    const kind = typeof record.metadata?.kind === "string" ? record.metadata.kind : undefined;
    const usage = readResponseUsage(record.metadata?.usage);
    messages.push({ role: "tool", content: record.content, ...(toolCallId ? { toolCallId } : {}), ...(typeof toolOk === "boolean" ? { toolOk } : {}), ...(toolFileEvent ? { toolFileEvent } : {}), ...(toolWebEvent ? { toolWebEvent } : {}), ...(toolMcpEvent ? { toolMcpEvent } : {}), ...(toolProcessEvent ? { toolProcessEvent } : {}), ...(kind ? { kind } : {}), ...(usage ? { usage } : {}), ...(images ? { images } : {}) });
  }
  return { messages, ...(engine ? { engine } : {}), ...(providerSelection ? { providerSelection } : {}), ...(reasoningTier ? { reasoningTier } : {}), ...(reasoningDisplayMode ? { reasoningDisplayMode } : {}), ...(permissionMode ? { permissionMode } : {}), ...(assets ? { assets } : {}), ...(harness ? { harness } : {}) };
}

function isPermissionMode(value: unknown): value is PermissionMode { return value === "MANUAL" || value === "INERTIA" || value === "MOMENTUM" || value === "YOLO"; }
function readEngineId(value: unknown): EngineId | undefined { return typeof value === "string" && (engineIds as readonly string[]).includes(value) ? value as EngineId : undefined; }
function readReasoningTier(value: unknown): ReasoningTier | undefined { return typeof value === "string" && (reasoningTiers as readonly string[]).includes(value) ? value as ReasoningTier : undefined; }
function readReasoningDisplayMode(value: unknown): ReasoningDisplayMode | undefined { return value === "hidden" || value === "collapsed" || value === "expanded" ? value : undefined; }
function readHarnessRuntimeIdentity(value: unknown): HarnessRuntimeIdentity | undefined {
  if (value === undefined) return undefined;
  try {
    return parseHarnessRuntimeIdentity(value);
  } catch (error) {
    throw new Error(`Session Harness identity is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readThinkingBlocks(value: unknown): ProviderThinkingBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks = value.filter(isKnownThinkingBlock);
  return blocks.length > 0 ? blocks : undefined;
}
function isKnownThinkingBlock(value: unknown): value is ProviderThinkingBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as ProviderThinkingBlock;
  if (block.type === "reasoning") return typeof block.reasoningContent === "string";
  if (block.type === "thinking") return typeof block.thinking === "string";
  if (block.type === "redacted_thinking") return typeof block.data === "string";
  return block.type === "thought_summary" && (typeof block.text === "string" || typeof block.summary === "string");
}
function readResponseUsage(value: unknown): ResponseUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const usage: ResponseUsage = {};
  for (const key of ["contextInputTokens", "inputTokens", "outputTokens", "totalTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "cacheHitInputTokens", "cacheMissInputTokens", "reasoningTokens", "effectiveTokens"] as const) {
    if (typeof source[key] === "number" && Number.isFinite(source[key])) (usage as Record<string, unknown>)[key] = source[key];
  }
  if (source.providerDetails && typeof source.providerDetails === "object" && !Array.isArray(source.providerDetails)) usage.providerDetails = { ...(source.providerDetails as Record<string, unknown>) };
  return Object.keys(usage).length > 0 ? usage : undefined;
}
