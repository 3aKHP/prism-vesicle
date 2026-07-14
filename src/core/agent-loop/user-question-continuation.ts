import type { VesicleMessage } from "../../providers/shared/types";
import type { ToolPermissionBroker } from "../permissions";
import type { UserQuestionAnswer, UserQuestionRequest } from "../user-question/types";
import type { AgentLoopEvent, RunPromptResult } from "./types";
import type { ContinuationContextOptions } from "./continuation-context";
import { loadContinuationContext } from "./continuation-context";
import { generationMetadata } from "./generation";
import { runLoop } from "./turn-loop";
import { FileCheckpointManager } from "../checkpoints/file-history";
import type { AgentManager } from "../agents/manager";
import type { AgentMetadata } from "../agents/types";
import { AgentStore } from "../agents/store";
import { agentTerminalToolResult } from "../agents/tools";
import { createTurnAgentManager } from "./agent-manager";
import {
  harnessDelegationFailureDecision,
  bindHarnessDelegation,
  type HarnessDelegationDecision,
  type HarnessRuntimeContext,
} from "../harness/driver";
import type { ToolCall } from "../tools";
import { recordToolResult } from "./tool-result-recorder";
import { appendHarnessDelegationDecision } from "./delegation-decision";

type ResolveUserQuestionOptions = ContinuationContextOptions & {
  messages: VesicleMessage[];
  toolCallId: string;
  question: UserQuestionRequest;
  answer: UserQuestionAnswer;
  delegationDecision?: HarnessDelegationDecision;
  permissionBroker?: ToolPermissionBroker;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager?: AgentManager;
};

export async function resolveUserQuestion(options: ResolveUserQuestionOptions): Promise<RunPromptResult> {
  const context = await loadContinuationContext(options);
  const contractOption = resolveContractOption(options);
  const preparedRetry = contractOption?.id === "retry"
    ? await prepareAuthorizedDelegationRetry(context, options.delegationDecision!)
    : undefined;
  if (preparedRetry) {
    await context.session.append({
      role: "system",
      content: "",
      metadata: {
        kind: "delegation-retry-intent",
        retryIntent: {
          id: preparedRetry.intentId,
          interactionId: options.delegationDecision!.interactionId,
          failedRunId: preparedRetry.failed.runId,
          delegationId: preparedRetry.failed.delegation!.id,
          attempt: preparedRetry.failed.delegation!.attempt + 1,
          retryCallId: preparedRetry.retryCall.id,
        },
      },
    });
  }
  const toolResultContent = JSON.stringify({
    ok: true,
    answer: {
      question: options.question.question,
      selectedIndex: options.answer.selectedIndex,
      label: options.answer.label,
      description: options.answer.description,
      ...(options.answer.kind ? { kind: options.answer.kind } : {}),
      ...(contractOption ? {
        interactionId: options.delegationDecision!.interactionId,
        optionId: contractOption.id,
      } : {}),
      ...(options.answer.freeformText ? { freeformText: options.answer.freeformText } : {}),
    },
  });
  const messages: VesicleMessage[] = [...options.messages, {
    role: "tool",
    toolCallId: options.toolCallId,
    content: toolResultContent,
  }];
  await context.session.append({
    role: "tool",
    content: toolResultContent,
    metadata: {
      engine: options.engine,
      name: "ask_user_question",
      ok: true,
      toolCallId: options.toolCallId,
      header: options.question.header,
      question: options.question.question,
      selectedIndex: options.answer.selectedIndex,
      label: options.answer.label,
      ...(contractOption ? {
        kind: "delegation-decision-resolution",
        interactionId: options.delegationDecision!.interactionId,
        optionId: contractOption.id,
        failedRunId: options.delegationDecision!.failed.runId,
        delegationId: options.delegationDecision!.failed.delegation.id,
        failedAttempt: options.delegationDecision!.failed.delegation.attempt,
        ...(preparedRetry ? { retryIntentId: preparedRetry.intentId } : {}),
      } : options.answer.kind ? { kind: options.answer.kind } : {}),
      ...(options.answer.freeformText ? { freeformText: options.answer.freeformText } : {}),
    },
  });

  const userFollowUp = userQuestionFollowUpMessage(options.question, options.answer);
  messages.push({ role: "user", content: userFollowUp });
  await context.session.append({
    role: "user",
    content: userFollowUp,
    metadata: {
      engine: options.engine,
      provider: context.config.provider,
      providerId: context.config.providerId,
      model: context.config.model,
      ...generationMetadata(context.generation),
      kind: contractOption ? "delegation-decision-answer" : "user-question-answer",
      questionHeader: options.question.header,
      selectedIndex: options.answer.selectedIndex,
      label: options.answer.label,
      ...(options.answer.kind ? { answerKind: options.answer.kind } : {}),
      ...(contractOption ? {
        interactionId: options.delegationDecision!.interactionId,
        optionId: contractOption.id,
        ...(preparedRetry ? { retryIntentId: preparedRetry.intentId } : {}),
      } : {}),
    },
  });

  const manager = options.agentManager ?? createTurnAgentManager(context.rootDir, options.onEvent);
  const checkpoint = await FileCheckpointManager.resumeLatest(context.rootDir, context.session);
  if (preparedRetry) {
    const retry = await executeAuthorizedDelegationRetry({
      context,
      messages,
      decision: options.delegationDecision!,
      manager,
      checkpoint,
      prepared: preparedRetry,
      signal: options.signal,
      onEvent: options.onEvent,
      permissionBroker: options.permissionBroker,
    });
    if (retry) return retry;
  }

  return runLoop({
    rootDir: context.rootDir,
    config: context.config,
    provider: context.provider,
    systemPrompt: context.systemPrompt,
    tools: context.toolSurface.definitions,
    mcpRegistry: context.toolSurface.mcp,
    messages,
    session: context.session,
    profile: context.profile,
    generation: context.generation,
    checkpoint,
    signal: options.signal,
    onEvent: options.onEvent,
    agentManager: manager,
    permission: context.permission,
    permissionBroker: options.permissionBroker,
    harness: context.harness,
    assets: context.assets,
  });
}

function resolveContractOption(options: ResolveUserQuestionOptions) {
  if (!options.delegationDecision) return undefined;
  if (options.answer.kind === "skip" || options.answer.kind === "freeform") {
    throw new Error("Harness delegation decisions accept only Contract-declared options.");
  }
  const option = options.delegationDecision.question.options.find((candidate) =>
    candidate.id && candidate.id === options.answer.optionId
  );
  if (!option?.id) throw new Error("Harness delegation decision answer does not match a declared option id.");
  return option as typeof option & { id: string };
}

async function executeAuthorizedDelegationRetry(options: {
  context: Awaited<ReturnType<typeof loadContinuationContext>>;
  messages: VesicleMessage[];
  decision: HarnessDelegationDecision;
  manager: AgentManager;
  checkpoint?: FileCheckpointManager;
  prepared: PreparedDelegationRetry;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  permissionBroker?: ToolPermissionBroker;
}): Promise<RunPromptResult | undefined> {
  const { failed, harness, retryCall, intentId } = options.prepared;
  options.messages.push({ role: "assistant", content: "", toolCalls: [retryCall] });
  await options.context.session.append({
    role: "assistant",
    content: "",
    metadata: {
      kind: "delegation-user-retry",
      retryIntentId: intentId,
      engine: options.context.profile.id,
      interactionId: options.decision.interactionId,
      authorizedByRunId: failed.runId,
      delegationId: failed.delegation.id,
      attempt: failed.delegation.attempt + 1,
      toolCalls: [retryCall],
    },
  });
  const child = await options.manager.spawn({
    profileId: failed.profileId,
    description: failed.description,
    prompt: failed.prompt,
    mode: failed.mode,
    parentSessionId: failed.parentSessionId,
    parentToolCallId: retryCall.id,
    delegation: { ...failed.delegation, attempt: failed.delegation.attempt + 1 },
  }, {
    rootDir: options.context.rootDir,
    parentEngine: options.context.profile.id,
    providerSelection: { provider: options.context.config.providerId, model: options.context.config.model },
    generation: options.context.generation,
    parentToolDefinitions: options.context.toolSurface.definitions,
    parentSystemPrompt: options.context.systemPrompt,
    parentMessages: options.messages,
    parentSignal: options.signal,
    beforeMutation: async (paths) => options.checkpoint?.trackBeforeMutation(paths),
    permission: options.context.permission,
    permissionBroker: options.permissionBroker,
    harness,
    assets: options.context.assets,
  });
  const terminal = await child.completion;
  const toolResult = agentTerminalToolResult(retryCall, terminal);
  const nextDecision = terminal.status === "failed" && terminal.delegation
    ? harnessDelegationFailureDecision(harness, options.context.profile.id, {
      runId: terminal.runId,
      handle: terminal.handle,
      delegation: terminal.delegation,
      errorCategory: terminal.errorCategory ?? "failed",
    })
    : undefined;
  await recordToolResult({
    result: toolResult,
    messages: options.messages,
    session: options.context.session,
    metadata: {
      kind: "subagent-result",
      agentEvent: toolResult.agentEvent,
      authorizedByRunId: failed.runId,
      interactionId: options.decision.interactionId,
      retryIntentId: intentId,
      ...(nextDecision ? { delegationDecision: nextDecision } : {}),
    },
    onEvent: options.onEvent,
  });
  if (!nextDecision) return undefined;
  const pause = await appendHarnessDelegationDecision({
    decision: nextDecision,
    messages: options.messages,
    session: options.context.session,
    engine: options.context.profile.id,
    onEvent: options.onEvent,
  });
  return {
    kind: "needs_user_question",
    sessionId: options.context.session.sessionId,
    sessionPath: options.context.session.sessionPath,
    profile: options.context.profile,
    question: pause.question,
    delegationDecision: pause.decision,
    toolCallId: pause.toolCallId,
    assistantContent: "",
    messages: options.messages,
  };
}

type PreparedDelegationRetry = {
  intentId: string;
  failed: AgentMetadata & { delegation: NonNullable<AgentMetadata["delegation"]> };
  harness: HarnessRuntimeContext;
  retryCall: ToolCall;
};

async function prepareAuthorizedDelegationRetry(
  context: Awaited<ReturnType<typeof loadContinuationContext>>,
  decision: HarnessDelegationDecision,
): Promise<PreparedDelegationRetry> {
  const harness = context.harness;
  if (!harness) throw new Error("Cannot resume a Harness delegation retry without the verified active Harness context.");
  const failed = await new AgentStore(context.rootDir).load(decision.failed.runId);
  if (!failed?.delegation
    || failed.status !== "failed"
    || failed.parentSessionId !== context.session.sessionId
    || failed.profileId !== decision.failed.delegation.agent
    || failed.mode !== decision.failed.delegation.mode
    || !sameDelegation(failed.delegation, decision.failed.delegation)) {
    throw new Error("The failed Harness delegation no longer matches the durable decision point.");
  }
  const current = bindHarnessDelegation(harness, context.profile.id, failed.profileId, failed.mode);
  if (!sameDelegation(current, failed.delegation)) {
    throw new Error("The active Harness no longer matches the failed delegation binding.");
  }
  const retryCall: ToolCall = {
    id: `delegation-retry_${crypto.randomUUID()}`,
    name: "spawn_agent",
    arguments: JSON.stringify({
      profile: failed.profileId,
      description: failed.description,
      prompt: failed.prompt,
      mode: failed.mode,
    }),
  };
  return {
    intentId: `delegation-retry-intent_${crypto.randomUUID()}`,
    failed: failed as PreparedDelegationRetry["failed"],
    harness,
    retryCall,
  };
}

function sameDelegation(
  left: DelegationIdentity,
  right: DelegationIdentity,
): boolean {
  return left.id === right.id
    && left.agent === right.agent
    && left.mode === right.mode
    && left.purpose === right.purpose
    && left.retryLimit === right.retryLimit
    && left.parentEngine === right.parentEngine
    && left.packId === right.packId
    && left.packVersion === right.packVersion
    && left.driverId === right.driverId
    && left.driverVersion === right.driverVersion
    && (!("attempt" in left) || !("attempt" in right) || left.attempt === right.attempt);
}

type DelegationIdentity = {
  id: string;
  agent: string;
  mode: AgentMetadata["mode"];
  purpose: string;
  retryLimit: number;
  parentEngine: HarnessDelegationDecision["failed"]["delegation"]["parentEngine"];
  packId: string;
  packVersion: string;
  driverId: string;
  driverVersion: string;
  attempt?: number;
};

function userQuestionFollowUpMessage(question: UserQuestionRequest, answer: UserQuestionAnswer): string {
  if (answer.kind === "skip") {
    return `[question:${question.header} skipped] User skipped the question. Continue with best judgment.`;
  }
  if (answer.kind === "freeform") {
    const text = answer.freeformText?.trim();
    return text
      ? `[question:${question.header} answered freely] ${text}`
      : `[question:${question.header} answered freely] User selected Other but did not provide additional text.`;
  }
  return `[question:${question.header} answered] ${answer.label} — ${answer.description}`;
}
