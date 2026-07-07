import type { VesicleConfig } from "../../config/env";
import { loadConfigForSelection } from "../../config/providers";
import type { ProviderSelection } from "../../config/providers";
import { createProvider } from "../../providers";
import type { ProviderAdapter, VesicleMessage, VesicleRequest, VesicleResponse } from "../../providers/shared/types";
import { executeFileTool, fileToolDefinitions } from "../tools";
import type { ToolCall, ToolDefinition } from "../tools";
import { composeSystemPrompt, loadPromptBundle } from "../prompt/loader";
import type { EngineId } from "../engine/profile";
import { loadEngineProfile } from "../engine/profile";
import type { EngineProfile } from "../engine/profile";
import { createSessionStore } from "../session/store";
import type { SessionStore } from "../session/store";
import { gateToolDefinition } from "../gate/types";
import { parseGateRequest } from "../gate/types";
import type { GateRequest, GateResolution } from "../gate/types";
import { resolveValidators, runValidators } from "../validators/registry";
import type { ValidationResult } from "../validators/registry";

export type { EngineId } from "../engine/profile";
export type { GateRequest, GateResolution } from "../gate/types";

export type RunPromptOptions = {
  input: string;
  engine?: EngineId;
  rootDir?: string;
  sessionId?: string;
  messages?: VesicleMessage[];
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  onEvent?: (event: AgentLoopEvent) => void;
};

export type AgentLoopEvent =
  | { type: "provider_request"; iteration: number }
  | { type: "assistant_delta"; delta: string }
  | { type: "assistant_reasoning_delta"; delta: string }
  | { type: "tool_call_delta"; name?: string; argumentsDelta?: string }
  | {
      type: "assistant_response";
      content: string;
      reasoningContent?: string;
      toolCalls: Array<{ id: string; name: string; arguments: string }>;
    }
  | { type: "tool_call"; name: string; callId: string; arguments: string }
  | { type: "tool_result"; name: string; callId: string; ok: boolean; content: string }
  | { type: "gate_pending"; gate: string }
  | { type: "validation"; ok: boolean };

/**
 * Result of a turn. Discriminated by `kind`:
 *
 * - `complete`     — the model produced a final assistant message with no
 *                     outstanding tool calls. The turn is done.
 * - `needs_user`   — the model called request_confirmation for a declared
 *                     gate. The host must render the gate, collect a
 *                     resolution, and call resolveGate() before continuing.
 *
 * Option A from the design discussion: the loop stays stateless and returns
 * a value that the caller interprets, rather than calling back into the UI.
 * Session state is durable JSONL, so resuming is just reading the session
 * and feeding the resolution as the next turn.
 */
export type ValidatorOutcome = {
  ok: boolean;
  results: Array<{ name: string; result: ValidationResult }>;
};

export type RunPromptResult =
  | {
      kind: "complete";
      sessionId: string;
      sessionPath: string;
      response: VesicleResponse;
      profile: EngineProfile;
      /**
       * Validator outcomes for the final assistant content. Present only when
       * the engine profile declares validators; absent (undefined) otherwise.
       * Warnings surface in the per-validator results but do not flip ok.
       */
      validation?: ValidatorOutcome;
      /**
       * The full in-memory message list threaded through this turn. Callers
       * that continue the conversation (TUI, resolveGate) should carry this
       * forward rather than reconstructing from a stale snapshot, so tool
       * calls and results stay correctly paired for the next provider call.
       */
      messages: VesicleMessage[];
    }
  | {
      kind: "needs_user";
      sessionId: string;
      sessionPath: string;
      profile: EngineProfile;
      /**
       * The gate call that paused the loop. Render this in the TUI and pass
       * the user's choice to resolveGate().
       */
      gate: GateRequest;
      /**
       * The tool call id the model used. resolveGate() writes the tool
       * result against this id so the model's next turn sees the decision.
       */
      toolCallId: string;
      /**
       * The assistant content produced alongside the gate call. May contain
       * the blueprint the model wants confirmed; useful to render even
       * before the user resolves the gate.
       */
      assistantContent: string;
      /**
       * In-memory message list to thread into the next runPrompt call. The
       * loop does not close over state across turns; the caller carries it.
       */
      messages: VesicleMessage[];
    };

/**
 * Hard ceiling on tool round-trips per turn. Vesicle is not a coding agent
 * running untrusted bash — its tools are controlled file reads/writes inside
 * guarded roots. ETL alone may legitimately read several specs/templates,
 * enumerate source_materials, and write multiple phase artifacts in one turn,
 * so a single-digit cap (the old value was 6) truncates real workflows.
 *
 * The real protection against a stuck model is the no-progress breaker
 * below, not this number.
 */
const maxToolIterations = 40;

/**
 * If this many consecutive tool results report failure, the loop stops and
 * surfaces the last response rather than retrying silently. A model that
 * keeps calling tools that error is genuinely stuck; a model that keeps
 * calling tools that succeed is just doing its job.
 */
const maxConsecutiveFailedTools = 4;

export async function runPrompt(options: RunPromptOptions): Promise<RunPromptResult> {
  const engine = options.engine ?? "etl";
  const rootDir = options.rootDir ?? process.cwd();
  const config = await loadConfigForSelection(options.providerSelection);
  const generation = mergeGeneration(config.generation, options.generation);
  const provider = createProvider(config);
  const profile = await loadEngineProfile(engine, rootDir);
  const promptBundle = await loadPromptBundle(profile, rootDir);
  const systemPrompt = composeSystemPrompt(promptBundle);
  const tools = resolveTools(profile);
  const isNewSession = !options.sessionId;
  const session = await createSessionStore(rootDir, options.sessionId);

  if (isNewSession) {
    await session.append({
      role: "system",
      content: systemPrompt,
      metadata: {
        engine,
        provider: config.provider,
        providerId: config.providerId,
        model: config.model,
        ...generationMetadata(generation),
        profile: {
          displayName: profile.displayName,
          protocolVersion: profile.protocolVersion,
          tools: profile.defaultTools,
          validators: profile.validators,
          stopGates: profile.stopGates,
        },
      },
    });
  }

  await session.append({
    role: "user",
    content: options.input,
    metadata: {
      provider: config.provider,
      providerId: config.providerId,
      model: config.model,
      ...generationMetadata(generation),
    },
  });

  const messages: VesicleMessage[] = options.messages ?? [
    {
      role: "user",
      content: options.input,
    },
  ];

  return runLoop({
    rootDir,
    config,
    provider,
    systemPrompt,
    tools,
    messages,
    session,
    profile,
    generation,
    onEvent: options.onEvent,
  });
}

type RunLoopArgs = {
  rootDir: string;
  config: VesicleConfig;
  provider: ReturnType<typeof createProvider>;
  systemPrompt: string;
  tools: ToolDefinition[];
  messages: VesicleMessage[];
  session: SessionStore;
  profile: EngineProfile;
  generation?: VesicleRequest["generation"];
  onEvent?: (event: AgentLoopEvent) => void;
};

async function runLoop(args: RunLoopArgs): Promise<RunPromptResult> {
  const { rootDir, config, provider, systemPrompt, tools, messages, session, profile, generation, onEvent } = args;
  const declaredGates = new Set(profile.stopGates);

  let response: VesicleResponse | undefined;
  let consecutiveFailures = 0;

  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    onEvent?.({ type: "provider_request", iteration });
    response = await completeWithStreaming(provider, {
      id: session.sessionId,
      model: {
        provider: config.providerId,
        model: config.model,
      },
      system: [systemPrompt],
      messages,
      tools,
      generation,
    }, onEvent);

    const toolCalls = response.toolCalls ?? [];
    onEvent?.({
      type: "assistant_response",
      content: response.content,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
    });
    if (toolCalls.length === 0) {
      break;
    }

    // Partition tool calls into file tools (execute immediately) and gate
    // calls (pause the loop). A single assistant turn may legitimately mix
    // both: the model reads several specs, then calls request_confirmation
    // for the blueprint. We run the file tools first so their results are
    // persisted, then hand off to the gate.
    const fileCalls: ToolCall[] = [];
    const gateCalls: ToolCall[] = [];
    for (const call of toolCalls) {
      if (call.name === "request_confirmation") {
        gateCalls.push(call);
      } else {
        fileCalls.push(call);
      }
    }

    // Persist the assistant turn carrying all tool calls (file + gate) as
    // one message, mirroring the provider's tool_call grouping. The
    // individual tool results are appended below.
    messages.push({
      role: "assistant",
      content: response.content,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
      toolCalls,
    });
    await session.append({
      role: "assistant",
      content: response.content,
      metadata: {
        providerResponseId: response.id,
        finishReason: response.finishReason,
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        toolCalls,
      },
    });

    let anyFailed = false;

    for (const call of fileCalls) {
      onEvent?.({ type: "tool_call", name: call.name, callId: call.id, arguments: call.arguments });
      const toolResult = await executeFileTool(rootDir, call);
      const content = JSON.stringify({
        ok: toolResult.ok,
        result: toolResult.content,
      });

      messages.push({
        role: "tool",
        toolCallId: toolResult.callId,
        content,
      });
      await session.append({
        role: "tool",
        content,
        metadata: {
          name: toolResult.name,
          ok: toolResult.ok,
          toolCallId: toolResult.callId,
        },
      });

      if (!toolResult.ok) {
        anyFailed = true;
      }
      onEvent?.({
        type: "tool_result",
        name: toolResult.name,
        callId: toolResult.callId,
        ok: toolResult.ok,
        content: toolResult.content,
      });
    }

    if (gateCalls.length > 0) {
      // Use the first gate call. If the model emitted several, the extras
      // are answered with a redirect so the provider's tool_call pairing
      // stays balanced and the model converges on one gate at a time.
      const [primary, ...extras] = gateCalls;
      const gate = parseGateRequest(primary);

      if (!declaredGates.has(gate.gate)) {
        // Undeclared gate: do not pause. Tell the model this gate is not
        // available so it can self-correct on the next turn.
        const refusal = JSON.stringify({
          ok: false,
          result: `Gate "${gate.gate}" is not declared by engine "${profile.id}". Declared gates: ${[...declaredGates].join(", ") || "(none)"}.`,
        });
        messages.push({ role: "tool", toolCallId: primary.id, content: refusal });
        await session.append({
          role: "tool",
          content: refusal,
          metadata: { name: "request_confirmation", ok: false, toolCallId: primary.id, reason: "undeclared-gate" },
        });
        anyFailed = true;
      } else {
        for (const extra of extras) {
          const redirect = JSON.stringify({
            ok: false,
            result: "Only one gate may be open at a time. The primary gate request is pending user resolution.",
          });
          messages.push({ role: "tool", toolCallId: extra.id, content: redirect });
          await session.append({
            role: "tool",
            content: redirect,
            metadata: { name: "request_confirmation", ok: false, toolCallId: extra.id, reason: "extra-gate-redirect" },
          });
        }

        onEvent?.({ type: "gate_pending", gate: gate.gate });
        return {
          kind: "needs_user",
          sessionId: session.sessionId,
          sessionPath: session.sessionPath,
          profile,
          gate,
          toolCallId: primary.id,
          assistantContent: response.content,
          messages,
        };
      }
    }

    if (anyFailed) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailedTools) {
        await session.append({
          role: "system",
          content: `Tool loop stopped after ${consecutiveFailures} consecutive rounds of failing tool results.`,
          metadata: { kind: "no-progress-breaker" },
        });
        break;
      }
    } else {
      consecutiveFailures = 0;
    }
  }

  if (!response) {
    throw new Error("Provider did not return a response.");
  }

  const finalResponseHasToolCalls = (response.toolCalls?.length ?? 0) > 0;
  if (!finalResponseHasToolCalls) {
    messages.push({
      role: "assistant",
      content: response.content,
      ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
    });
    await session.append({
      role: "assistant",
      content: response.content,
      metadata: {
        providerResponseId: response.id,
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        usage: response.usage,
      },
    });
  }

  // Run declared validators on the final assistant content. Validators are
  // advisory — failures surface to the TUI and session but never abort the
  // turn. The model's output is the source of truth; validators check it.
  let validation: ValidatorOutcome | undefined;
  if (profile.validators.length > 0 && shouldValidateAssistantContent(response.content)) {
    const validators = resolveValidators(profile.validators);
    validation = runValidators(validators, response.content);
    await session.append({
      role: "system",
      content: summariseValidation(validation),
      metadata: { kind: "validation", ok: validation.ok },
    });
    onEvent?.({ type: "validation", ok: validation.ok });
  }

  return {
    kind: "complete",
    sessionId: session.sessionId,
    sessionPath: session.sessionPath,
    response,
    profile,
    validation,
    /**
     * The full in-memory message list threaded through this turn, including
     * any tool calls and results. The TUI carries this forward so the next
     * user prompt builds on a consistent view rather than a stale snapshot.
     */
    messages,
  };
}

async function completeWithStreaming(
  provider: ProviderAdapter,
  request: VesicleRequest,
  onEvent?: (event: AgentLoopEvent) => void,
): Promise<VesicleResponse> {
  if (!provider.stream) {
    return provider.complete(request);
  }

  let response: VesicleResponse | undefined;
  for await (const event of provider.stream(request)) {
    switch (event.type) {
      case "content_delta":
        onEvent?.({ type: "assistant_delta", delta: event.delta });
        break;
      case "reasoning_delta":
        onEvent?.({ type: "assistant_reasoning_delta", delta: event.delta });
        break;
      case "tool_call_delta":
        onEvent?.({
          type: "tool_call_delta",
          name: event.name,
          argumentsDelta: event.argumentsDelta,
        });
        break;
      case "complete":
        response = event.response;
        break;
    }
  }

  if (!response) {
    throw new Error("Provider stream ended without a final response.");
  }
  return response;
}

function shouldValidateAssistantContent(content: string): boolean {
  const trimmed = content.trimStart();
  // ETL validators target Prism artifact documents, not ordinary phase
  // transition prose. A generated artifact starts with YAML frontmatter; prose
  // such as "confirmed, moving to Phase 1" should remain a normal assistant
  // message and not be reported as a schema failure.
  return trimmed.startsWith("---");
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

/**
 * Resolve a gate that paused the loop. Writes the user's decision as the
 * tool result for the gate call, persists a gate-resolution record, and
 * continues the loop by treating the decision as a new user turn.
 *
 * For `confirm` the engine advances. For `revise` the feedback is forwarded
 * so the engine can rework the artifact. For `chat` the gate is closed
 * without advancing; the user's feedback (if any) still reaches the model
 * as a normal user message.
 *
 * This mirrors the session shape runPrompt would produce, so a resumed
 * session reads back consistently whether the gate was resolved in-process
 * or after a TUI restart.
 */
export async function resolveGate(options: {
  engine: EngineId;
  rootDir?: string;
  sessionId: string;
  messages: VesicleMessage[];
  toolCallId: string;
  gate: GateRequest;
  resolution: GateResolution;
  providerSelection?: Partial<ProviderSelection>;
  generation?: VesicleRequest["generation"];
  onEvent?: (event: AgentLoopEvent) => void;
}): Promise<RunPromptResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = await loadConfigForSelection(options.providerSelection);
  const generation = mergeGeneration(config.generation, options.generation);
  const provider = createProvider(config);
  const profile = await loadEngineProfile(options.engine, rootDir);
  const promptBundle = await loadPromptBundle(profile, rootDir);
  const systemPrompt = composeSystemPrompt(promptBundle);
  const tools = resolveTools(profile);
  const session = await createSessionStore(rootDir, options.sessionId);

  const toolResultContent = JSON.stringify({
    ok: true,
    result: gateResultMessage(options.resolution),
  });

  // Copy the caller's message list rather than mutating it in place. The
  // caller may still hold a reference for display or a second gate, so
  // aliasing its array would surprise it (CR S2/B2).
  const messages: VesicleMessage[] = [...options.messages];
  messages.push({
    role: "tool",
    toolCallId: options.toolCallId,
    content: toolResultContent,
  });
  await session.append({
    role: "tool",
    content: toolResultContent,
    metadata: {
      name: "request_confirmation",
      ok: true,
      toolCallId: options.toolCallId,
      gate: options.gate.gate,
      decision: options.resolution.decision,
    },
  });

  const userFollowUp = gateFollowUpMessage(options.gate, options.resolution);
  messages.push({ role: "user", content: userFollowUp });
  await session.append({
    role: "user",
    content: userFollowUp,
    metadata: {
      provider: config.provider,
      providerId: config.providerId,
      model: config.model,
      ...generationMetadata(generation),
    },
  });

  return runLoop({
    rootDir,
    config,
    provider,
    systemPrompt,
    tools,
    messages,
    session,
    profile,
    generation,
    onEvent: options.onEvent,
  });
}

function mergeGeneration(
  defaults: VesicleConfig["generation"],
  override: VesicleRequest["generation"],
): VesicleRequest["generation"] | undefined {
  const merged = {
    ...(defaults ?? {}),
    ...(override ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function generationMetadata(generation: VesicleRequest["generation"] | undefined): Record<string, unknown> {
  return {
    ...(generation?.temperature !== undefined ? { temperature: generation.temperature } : {}),
    ...(generation?.maxTokens !== undefined ? { maxTokens: generation.maxTokens } : {}),
    ...(generation?.reasoningTier ? { reasoningTier: generation.reasoningTier } : {}),
  };
}

function gateResultMessage(resolution: GateResolution): string {
  switch (resolution.decision) {
    case "confirm":
      return resolution.feedback
        ? `Confirmed. Note from user: ${resolution.feedback}`
        : "Confirmed. Proceed to the next phase.";
    case "revise":
      return resolution.feedback
        ? `User requests revision: ${resolution.feedback}`
        : "User requests revision without specific feedback. Ask for clarification if needed.";
    case "chat":
      return resolution.feedback
        ? `User wants to discuss before deciding: ${resolution.feedback}`
        : "User wants to discuss this further before deciding.";
  }
}

function gateFollowUpMessage(gate: GateRequest, resolution: GateResolution): string {
  const head = `[gate:${gate.gate} resolved as ${resolution.decision}]`;
  return resolution.feedback ? `${head} ${resolution.feedback}` : head;
}

/**
 * Host contracts declared in profiles but never surfaced to the model as
 * function tools. They document what the host guarantees (loading config,
 * loading prompts, persisting sessions) but are executed by Vesicle
 * internally, not by the provider tool loop.
 */
const hostContractNames = new Set(["config.load", "prompt.load", "session.write"]);

/**
 * Resolve the engine's declared tool names to concrete tool definitions.
 * Names that are host contracts are skipped (they are documentation, not
 * model-visible tools). The request_confirmation gate tool is attached
 * automatically when the profile declares at least one stopGate, so an
 * engine with no declared gates never offers it and cannot be paused.
 */
function resolveTools(profile: EngineProfile): ToolDefinition[] {
  const byName = new Map(fileToolDefinitions.map((definition) => [definition.function.name, definition]));
  const resolved: ToolDefinition[] = [];

  for (const name of profile.defaultTools) {
    if (hostContractNames.has(name)) continue;
    const definition = byName.get(name);
    if (!definition) {
      throw new Error(
        `Engine "${profile.id}" declares unknown tool "${name}". Known model-visible tools: ${[...byName.keys()].join(", ")}.`,
      );
    }
    resolved.push(definition);
  }

  if (profile.stopGates.length > 0) {
    resolved.push(gateToolDefinition);
  }

  return resolved;
}
