/**
 * Offline preflight for a session-Harness migration (#239).
 *
 * Runs when resume finds the session's recorded Harness identity differs from
 * the active verified baseline. It reuses the real resume/bootstrap code paths
 * as far as possible without any provider call, session append, compaction,
 * MCP connection, or in-process freeze, and classifies each observation as
 * blocking (migration must be refused) or warning (migration may proceed with
 * the consequence visible in the report).
 *
 * Layers:
 * - `resume`: the dry-run of the pure resume steps (snapshot projection,
 *   engine/prompt resolution under the new baseline, pending-state
 *   compatibility, skill catalog re-resolution).
 * - `serializer`: a request-body round-trip through the session's own
 *   provider serializer. A throw predicts a request the serializer itself
 *   would refuse before any network I/O.
 * - `invariant`: protocol validators for the cross-message rules the
 *   serializers assume from the host (tool-call id pairing per protocol).
 * - `budget`: heuristic context-occupancy projection (no images).
 */

import { loadEngineAssetRuntime } from "../runtime/engine-assets";
import { composeSystemPromptWithInstructions } from "../instructions";
import { loadSessionSnapshot, type SessionSnapshot } from "../session/store";
import type { SessionMigrationPreflightLayer } from "../session/session-migration";
import { composeSkillCatalogBlock, eligibleCatalogNames, previewSessionSkillCatalogResolution, resolveEngineEligibleCatalog } from "../skills/catalog-context";
import { matchesQualityIdentity } from "./quality-continuation-bootstrap";
import { resolveBuiltInTools } from "./tool-surface";
import { agentToolDefinitions } from "../agents/tools";
import { loadTavilyApiKey } from "../tools/web/tavily-client";
import { loadConfigForSelection } from "../../config/providers";
import type { VesicleConfig } from "../../config/env";
import { prepareProviderMessages } from "../attachments/store";
import { toVesicleMessage } from "../compact/summary-generator";
import { estimateRequestTokens, evaluateBudgetCheck } from "../compact/context-budget";
import type { EngineId } from "../engine/profile";
import type { ProjectHarnessRuntime } from "../harness/activation";
import type { HarnessRuntimeIdentity } from "../harness/driver";
import type { VesicleMessage, VesicleRequest } from "../../providers/shared/types";
import { toChatCompletionBody } from "../../providers/openai-chat/request";
import { validateOpenAIChatHistory } from "../../providers/openai-chat/invariants";
import { toResponsesBody } from "../../providers/openai-responses/request";
import { responsesEndpointFingerprint } from "../../providers/openai-responses/owner";
import { toAnthropicMessagesBody } from "../../providers/anthropic-messages/request";
import { validateAnthropicHistory } from "../../providers/anthropic-messages/invariants";
import { toGeminiGenerateContentBody } from "../../providers/gemini-generate-content/request";
import { validateGeminiHistory } from "../../providers/gemini-generate-content/invariants";

export type MigrationPreflightFinding = {
  severity: "blocking" | "warning";
  layer: SessionMigrationPreflightLayer;
  message: string;
};

export type SessionMigrationPreflightReport = {
  sessionId: string;
  engine: EngineId;
  from: HarnessRuntimeIdentity | undefined;
  /** Undefined only in the broken-baseline case where nothing can be migrated onto. */
  to: HarnessRuntimeIdentity | undefined;
  findings: MigrationPreflightFinding[];
  verdict: "clean" | "warning" | "blocking";
};

export async function runSessionMigrationPreflight(options: {
  rootDir: string;
  sessionId: string;
  /** The already-resolved NEW baseline the migration would bind to. */
  projectHarness: ProjectHarnessRuntime;
  env?: NodeJS.ProcessEnv;
}): Promise<SessionMigrationPreflightReport> {
  const env = options.env ?? process.env;
  const to = options.projectHarness.harness.identity;
  const target = to ? `${to.packId}@${to.packVersion}` : "the active baseline";
  const findings: MigrationPreflightFinding[] = [];

  if (!to) {
    return conclude(options.sessionId, "etl", undefined, to, [{
      severity: "blocking",
      layer: "resume",
      message: "The active verified Harness baseline carries no runtime identity; there is nothing to migrate onto.",
    }]);
  }

  // --- Layer 0: resume dry-run -------------------------------------------------
  let snapshot: SessionSnapshot;
  try {
    snapshot = await loadSessionSnapshot(options.rootDir, options.sessionId, { synthesizeDanglingToolResults: false });
  } catch (error) {
    return conclude(options.sessionId, "etl", undefined, to, [{
      severity: "blocking",
      layer: "resume",
      message: `The session transcript cannot be projected: ${messageOf(error)}`,
    }]);
  }
  const from = snapshot.harness;
  const engine = snapshot.engine ?? "etl";

  let engineAssets: Awaited<ReturnType<typeof loadEngineAssetRuntime>>;
  try {
    engineAssets = await loadEngineAssetRuntime(engine, options.rootDir, { resolver: options.projectHarness.assets });
  } catch (error) {
    return conclude(options.sessionId, engine, from, to, [{
      severity: "blocking",
      layer: "resume",
      message: `Engine "${engine}" is not available under ${target}: ${messageOf(error)}`,
    }]);
  }

  let systemPrompt: string;
  try {
    systemPrompt = (await composeSystemPromptWithInstructions(engine, engineAssets.systemPrompt, options.rootDir)).systemPrompt;
  } catch (error) {
    return conclude(options.sessionId, engine, from, to, [{
      severity: "blocking",
      layer: "resume",
      message: `The system prompt for engine "${engine}" cannot be composed under ${target}: ${messageOf(error)}`,
    }]);
  }

  if (snapshot.pendingGate && !engineAssets.profile.stopGates.includes(snapshot.pendingGate.gate.gate)) {
    findings.push({
      severity: "blocking",
      layer: "resume",
      message: `The paused gate "${snapshot.pendingGate.gate.gate}" is not declared by engine "${engine}" under ${target}; the resumed interaction could never resolve.`,
    });
  }
  if (snapshot.pendingEngineSwitch) {
    const targetEngine = snapshot.pendingEngineSwitch.request.targetEngine;
    try {
      await loadEngineAssetRuntime(targetEngine, options.rootDir, { resolver: options.projectHarness.assets });
    } catch {
      findings.push({
        severity: "blocking",
        layer: "resume",
        message: `The pending engine switch to "${targetEngine}" cannot resolve under ${target}.`,
      });
    }
  }
  if (snapshot.pendingDelegationRetry) {
    findings.push({
      severity: "blocking",
      layer: "resume",
      message: "The session holds a pending SubAgent delegation retry, which resume already refuses; migrate after resolving or abandoning it.",
    });
  }

  const previewedCatalog = await previewSessionSkillCatalogResolution(
    options.rootDir,
    env,
    engineAssets.profile,
    snapshot.skillCatalogSnapshot,
  );
  const eligibleCatalog = resolveEngineEligibleCatalog(previewedCatalog, engineAssets.profile);
  for (const entry of snapshot.skillCatalogSnapshot?.entries ?? []) {
    if (!previewedCatalog.catalog.entries.some((candidate) => candidate.name === entry.name)) {
      findings.push({
        severity: "warning",
        layer: "resume",
        message: `Skill "${entry.name}" no longer resolves to the body this session froze and will leave the catalog.`,
      });
    }
  }

  if (snapshot.pendingQualityRewrite && !matchesQualityIdentity(options.projectHarness.harness.quality, snapshot.pendingQualityRewrite)) {
    const pending = snapshot.pendingQualityRewrite;
    findings.push({
      severity: "warning",
      layer: "resume",
      message: `The pending quality retry will be forfeited: it requires ${pending.packId}@${pending.packVersion} (Rule Pack ${pending.ruleVersion}), which differs from ${target}.`,
    });
  }
  if (snapshot.pendingQualityDecision && !matchesQualityIdentity(options.projectHarness.harness.quality, snapshot.pendingQualityDecision.qualityState)) {
    findings.push({
      severity: "warning",
      layer: "resume",
      message: "The pending quality decision point will keep its existing warning but cannot retry under the new Harness.",
    });
  }

  // --- Layer A + B: serializer round-trip and protocol invariants --------------
  let config: VesicleConfig | undefined;
  try {
    config = await loadConfigForSelection(snapshot.providerSelection, env);
  } catch {
    try {
      config = await loadConfigForSelection(undefined, env);
    } catch {
      config = undefined;
    }
  }
  if (!config) {
    findings.push({
      severity: "warning",
      layer: "serializer",
      message: "Provider configuration is unavailable; the serializer dry-run was skipped.",
    });
    return conclude(options.sessionId, engine, from, to, findings);
  }

  let sendable: SessionSnapshot;
  try {
    sendable = await loadSessionSnapshot(options.rootDir, options.sessionId, { synthesizeDanglingToolResults: true });
  } catch (error) {
    findings.push({
      severity: "warning",
      layer: "serializer",
      message: `The sendable projection could not be rebuilt; the serializer dry-run was skipped: ${messageOf(error)}`,
    });
    return conclude(options.sessionId, engine, from, to, findings);
  }

  let messages: VesicleMessage[] = sendable.messages.map(toVesicleMessage);
  const visionEnabled = config.capabilities?.vision === true;
  try {
    messages = await prepareProviderMessages(options.rootDir, messages, visionEnabled);
  } catch (error) {
    messages = messages.map((message) => ({ ...message, images: undefined }));
    findings.push({
      severity: "warning",
      layer: "serializer",
      message: `Image attachments could not be materialized; the serializer dry-run ran without them: ${messageOf(error)}`,
    });
  }

  const tavilyConfigured = (await loadTavilyApiKey(env)) !== undefined;
  const tools = [
    ...resolveBuiltInTools(
      engineAssets.profile,
      visionEnabled,
      false,
      "auto",
      eligibleCatalog.catalog.entries.length > 0 ? { catalogNames: eligibleCatalogNames(eligibleCatalog) } : undefined,
      { builtinSearchEnabled: false, tavilyConfigured },
    ),
    ...agentToolDefinitions,
  ];
  const skillBlock = composeSkillCatalogBlock(eligibleCatalog.catalog);
  const composedSystemPrompt = skillBlock ? `${systemPrompt}\n\n${skillBlock}` : systemPrompt;
  const request: VesicleRequest = {
    id: options.sessionId,
    model: { provider: config.providerId, model: config.model },
    system: [composedSystemPrompt],
    messages,
    tools,
    generation: config.generation,
  };

  if (snapshot.pendingPermission && !tools.some((tool) => tool.function.name === snapshot.pendingPermission!.toolName)) {
    findings.push({
      severity: "warning",
      layer: "resume",
      message: `The pending permission request for "${snapshot.pendingPermission.toolName}" is not part of the resolved tool surface; it will surface as a failed call on continuation.`,
    });
  }

  const validator = validatorFor(config);
  if (validator) {
    for (const violation of validator(messages)) {
      findings.push({ severity: "blocking", layer: "invariant", message: violation });
    }
  }

  try {
    serializeFor(config, request);
  } catch (error) {
    if (isConfigIntrinsicProviderError(config, error)) {
      findings.push({
        severity: "warning",
        layer: "serializer",
        message: `The provider configuration itself is rejected by the serializer (unrelated to migration): ${messageOf(error)}`,
      });
    } else {
      findings.push({
        severity: "blocking",
        layer: "serializer",
        message: `The projected history fails ${config.provider} request serialization: ${messageOf(error)}`,
      });
    }
  }

  // --- Budget heuristic --------------------------------------------------------
  const estimated = estimateRequestTokens(messages, composedSystemPrompt, tools);
  const budget = evaluateBudgetCheck({
    config: config.limits?.autoCompact,
    limits: config.limits,
    generation: config.generation,
    estimatedNextRequestTokens: estimated,
  });
  if (budget.kind === "soft-trigger" || budget.kind === "hard-ceiling") {
    findings.push({
      severity: "warning",
      layer: "budget",
      message: `Projected context occupancy ~${budget.projectedTokens} tokens exceeds the ${budget.kind === "hard-ceiling" ? "hard ceiling" : "soft trigger"} (${budget.kind === "hard-ceiling" ? budget.hardInputCeilingTokens : budget.softTriggerTokens}); the next turn will demand compaction. Heuristic estimate, image cost excluded.`,
    });
  }

  return conclude(options.sessionId, engine, from, to, findings);
}

function validatorFor(config: VesicleConfig): ((messages: VesicleMessage[]) => string[]) | undefined {
  switch (config.provider) {
    case "openai-chat-compatible": return validateOpenAIChatHistory;
    case "anthropic-messages": return validateAnthropicHistory;
    case "gemini-generate-content": return validateGeminiHistory;
    // The Responses serializer already fails closed on call_id declare/answer
    // invariants inside the Layer A round-trip; a second validator would
    // restate the same contract.
    default: return undefined;
  }
}

function serializeFor(config: VesicleConfig, request: VesicleRequest): void {
  switch (config.provider) {
    case "openai-chat-compatible":
      toChatCompletionBody(request, false);
      return;
    case "openai-responses":
      if (!config.responsesProfile) throw new Error("Responses profile is required for the serializer dry-run.");
      toResponsesBody(request, { providerId: config.providerId, endpointFingerprint: responsesEndpointFingerprint(config.baseUrl), profile: config.responsesProfile }, false, config.responsesProfile);
      return;
    case "anthropic-messages":
      toAnthropicMessagesBody(request);
      return;
    case "gemini-generate-content":
      toGeminiGenerateContentBody(request);
      return;
  }
}

/**
 * Serialize-time failures caused by the user's provider configuration exist
 * with or without migration, so they degrade to warnings instead of refusing
 * the migration. Scoped to the one known throw site — Anthropic thinking
 * enabled with a low maxTokens budget — rather than a message-substring
 * match across all providers, so a future serializer regression elsewhere
 * cannot be silently downgraded to a warning.
 */
function isConfigIntrinsicProviderError(config: VesicleConfig, error: unknown): boolean {
  return config.provider === "anthropic-messages"
    && error instanceof Error
    && error.message.includes("maxTokens");
}

function conclude(
  sessionId: string,
  engine: EngineId,
  from: HarnessRuntimeIdentity | undefined,
  to: HarnessRuntimeIdentity | undefined,
  findings: MigrationPreflightFinding[],
): SessionMigrationPreflightReport {
  const verdict = findings.some((finding) => finding.severity === "blocking")
    ? "blocking"
    : findings.some((finding) => finding.severity === "warning")
      ? "warning"
      : "clean";
  return { sessionId, engine, from, to, findings, verdict };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
