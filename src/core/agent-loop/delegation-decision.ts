import type { VesicleMessage } from "../../providers/shared/types";
import type { HarnessDelegationDecision } from "../harness/driver";
import type { SessionStore } from "../session/store";
import type { ToolCall } from "../tools";
import type { UserQuestionRequest } from "../user-question/types";
import type { AgentLoopEvent } from "./types";
import { failedToolResult, recordToolResult } from "./tool-result-recorder";

export type DelegationPause = {
  question: UserQuestionRequest;
  toolCallId: string;
  decision: HarnessDelegationDecision;
};

export async function appendHarnessDelegationDecision(options: {
  decision: HarnessDelegationDecision;
  messages: VesicleMessage[];
  session: SessionStore;
  engine: string;
  redirectCalls?: ToolCall[];
  onEvent?: (event: AgentLoopEvent) => void;
}): Promise<DelegationPause> {
  for (const call of options.redirectCalls ?? []) {
    await recordToolResult({
      result: failedToolResult(
        call.id,
        call.name,
        "A contract-bound delegation exhausted its retries; the Harness-declared failure decision point takes precedence.",
      ),
      messages: options.messages,
      session: options.session,
      metadata: { reason: "delegation-failure-decision-precedence" },
      emitEvent: false,
    });
  }
  const toolCall: ToolCall = {
    id: `delegation-decision_${crypto.randomUUID()}`,
    name: "ask_user_question",
    arguments: JSON.stringify({
      header: options.decision.question.header,
      question: options.decision.question.question,
      options: options.decision.question.options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
      })),
    }),
  };
  const question = options.decision.question;
  options.messages.push({ role: "assistant", content: "", toolCalls: [toolCall] });
  await options.session.append({
    role: "assistant",
    content: "",
    metadata: {
      kind: "delegation-decision-point",
      engine: options.engine,
      interactionId: options.decision.interactionId,
      decision: options.decision,
      toolCalls: [toolCall],
    },
  });
  options.onEvent?.({ type: "user_question_pending", header: question.header });
  return { question, toolCallId: toolCall.id, decision: options.decision };
}
