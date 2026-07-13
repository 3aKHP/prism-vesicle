import type { VesicleMessage, VesicleResponse } from "../../providers/shared/types";
import type { EngineProfile } from "../engine/profile";
import type { SessionStore } from "../session/store";
import { resolveValidators, runValidators } from "../validators/registry";
import type { AgentLoopEvent, RunPromptResult, ValidatorOutcome } from "./types";

export async function finalizeTurn(options: {
  response: VesicleResponse;
  messages: VesicleMessage[];
  session: SessionStore;
  profile: EngineProfile;
  model: string;
  onEvent?: (event: AgentLoopEvent) => void;
}): Promise<RunPromptResult> {
  const { response } = options;
  if ((response.toolCalls?.length ?? 0) === 0) {
    options.messages.push({
      role: "assistant",
      content: response.content,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
    });
    await options.session.append({
      role: "assistant",
      content: response.content,
      metadata: {
        engine: options.profile.id,
        model: options.model,
        providerResponseId: response.id,
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
        ...(response.usage ? { usage: response.usage } : {}),
      },
    });
  }

  const validation = await validateResponse(options);
  return {
    kind: "complete",
    sessionId: options.session.sessionId,
    sessionPath: options.session.sessionPath,
    response,
    profile: options.profile,
    validation,
    messages: options.messages,
  };
}

async function validateResponse(options: {
  response: VesicleResponse;
  session: SessionStore;
  profile: EngineProfile;
  onEvent?: (event: AgentLoopEvent) => void;
}): Promise<ValidatorOutcome | undefined> {
  if (options.profile.validators.length === 0) return undefined;
  const validators = resolveValidators(options.profile.validators);
  if (!validators.some((validator) => validator.applies(options.response.content))) return undefined;

  const validation = runValidators(validators, options.response.content);
  await options.session.append({
    role: "system",
    content: summariseValidation(validation),
    metadata: { kind: "validation", ok: validation.ok },
  });
  options.onEvent?.({ type: "validation", ok: validation.ok });
  return validation;
}

function summariseValidation(outcome: ValidatorOutcome): string {
  const lines: string[] = [];
  for (const entry of outcome.results) {
    const tag = entry.result.ok ? "PASS" : "FAIL";
    lines.push(`[${tag}] ${entry.name}`);
    for (const error of entry.result.errors) lines.push(`  error: ${error}`);
    for (const warning of entry.result.warnings) lines.push(`  warn: ${warning}`);
  }
  return lines.join("\n");
}
