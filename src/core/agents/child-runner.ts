import { bootstrapChildAgent } from "./child-bootstrap";
import { runChildProviderRound } from "./child-provider-round";
import {
  appendChildParentMessages,
  completeChildRun,
  createChildRunState,
  recordChildResponse,
  recordChildToolResult,
} from "./child-run-durability";
import { agentToolProgress, executeChildTool } from "./child-tool-executor";
import type { AgentRunner } from "./manager";

export { composeChildSystemPrompts, resolveChildTools } from "./child-bootstrap";
export { agentToolProgress } from "./child-tool-executor";

export const runChildAgent: AgentRunner = async ({
  runId,
  handle,
  spec,
  signal,
  invocation,
  onProgress,
  takeMessages,
  claimMutation,
  registerChildSession,
}) => {
  if (!invocation) throw new Error("SubAgent invocation context is missing.");
  const runtime = await bootstrapChildAgent({ runId, handle, spec, invocation, registerChildSession });
  const state = createChildRunState(runtime.messages);

  for (let iteration = 0; iteration < runtime.profile.maxTurns; iteration++) {
    if (signal.aborted) throw signal.reason;
    await appendChildParentMessages(state, takeMessages(), runtime.session, runId, handle);
    onProgress(`request ${iteration + 1}`);
    const response = await runChildProviderRound(runtime.provider, {
      id: runtime.session.sessionId,
      model: { provider: runtime.config.providerId, model: runtime.config.model },
      system: runtime.systemPrompts,
      messages: state.messages,
      tools: runtime.tools,
      generation: invocation.generation,
      signal,
    }, onProgress);
    const calls = await recordChildResponse(state, response, runtime.session, runId, handle);
    if (calls.length === 0) {
      // A parent message can arrive while the provider is streaming what would
      // otherwise be the terminal answer. Give that message a real next turn
      // instead of silently dropping an acknowledged send_message call.
      if (await appendChildParentMessages(state, takeMessages(), runtime.session, runId, handle) > 0) continue;
      return completeChildRun(
        state,
        response,
        runtime.session,
        runtime.profile.id,
        invocation,
        onProgress,
      );
    }

    for (const call of calls) {
      onProgress(agentToolProgress(call));
      const execution = await executeChildTool({
        call,
        runId,
        handle,
        spec,
        signal,
        invocation,
        session: runtime.session,
        mcp: runtime.mcp,
        checkpoint: runtime.checkpoint,
        claimMutation,
      });
      await recordChildToolResult(state, {
        call,
        result: execution.result,
        session: runtime.session,
        runId,
        handle,
        profileId: runtime.profile.id,
        permissionMode: execution.permissionMode,
        decisionSource: execution.decisionSource,
      });
    }
  }
  throw new Error(`SubAgent "${runtime.profile.id}" reached its maxTurns limit (${runtime.profile.maxTurns}).`);
};
