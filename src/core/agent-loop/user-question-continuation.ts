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

type ResolveUserQuestionOptions = ContinuationContextOptions & {
  messages: VesicleMessage[];
  toolCallId: string;
  question: UserQuestionRequest;
  answer: UserQuestionAnswer;
  permissionBroker?: ToolPermissionBroker;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void;
  agentManager?: AgentManager;
};

export async function resolveUserQuestion(options: ResolveUserQuestionOptions): Promise<RunPromptResult> {
  const context = await loadContinuationContext(options);
  const toolResultContent = JSON.stringify({
    ok: true,
    answer: {
      question: options.question.question,
      selectedIndex: options.answer.selectedIndex,
      label: options.answer.label,
      description: options.answer.description,
      ...(options.answer.kind ? { kind: options.answer.kind } : {}),
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
      ...(options.answer.kind ? { kind: options.answer.kind } : {}),
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
      kind: "user-question-answer",
      questionHeader: options.question.header,
      selectedIndex: options.answer.selectedIndex,
      label: options.answer.label,
      ...(options.answer.kind ? { answerKind: options.answer.kind } : {}),
    },
  });

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
    checkpoint: await FileCheckpointManager.resumeLatest(context.rootDir, context.session),
    signal: options.signal,
    onEvent: options.onEvent,
    agentManager: options.agentManager,
    permission: context.permission,
    permissionBroker: options.permissionBroker,
  });
}

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
