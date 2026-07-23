import type { VesicleMessage, VesicleResponse } from "../../providers/shared/types";
import type { EngineProfile } from "../engine/profile";
import type { SessionStore } from "../session/store";
import { validateContent } from "../validators/registry";
import type { AgentLoopEvent, RunPromptResult, ValidatorOutcome } from "./types";
import type { QualityOutcome } from "../quality";

export async function finalizeTurn(options: {
  response: VesicleResponse;
  messages: VesicleMessage[];
  session: SessionStore;
  profile: EngineProfile;
  model: string;
  onEvent?: (event: AgentLoopEvent) => void;
  quality?: { outcome: QualityOutcome; findingCount: number };
}): Promise<RunPromptResult> {
  const { response } = options;
  let assistantRecordUuid: string | undefined;
  if ((response.toolCalls?.length ?? 0) === 0) {
    options.messages.push({
      role: "assistant",
      content: response.content,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
    });
    const record = await options.session.append({
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
    assistantRecordUuid = record.uuid;
  }

  const validation = await validateResponse(options);
  return {
    kind: "complete",
    sessionId: options.session.sessionId,
    sessionPath: options.session.sessionPath,
    response,
    profile: options.profile,
    validation,
    ...(options.quality ? { quality: options.quality } : {}),
    ...(assistantRecordUuid ? { assistantRecordUuid } : {}),
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
  // Run only the validators whose `applies` predicate matches this content.
  // validateContent filters by applies, so a character card is not also run
  // through the scenario validator (and vice versa), and a `---`-led report or
  // ordinary prose triggers nothing.
  const validation = validateContent(options.profile.validators, options.response.content);
  if (!validation) return undefined;
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
