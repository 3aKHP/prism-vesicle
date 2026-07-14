import { engineIds, type EngineId } from "../engine/profile";
import type { AgentExecutionMode } from "../agents/profile";
import type { UserQuestionRequest } from "../user-question/types";
import { ProviderError } from "../../providers/shared/errors";
import { isRetryableStatus } from "../../providers/shared/fetch";
import type { QualityRuntimeContext } from "../quality/types";

export const harnessAdapterErrorCategories = [
  "unsupported",
  "invalid_request",
  "denied",
  "not_found",
  "conflict",
  "transient",
  "failed",
] as const;

export type HarnessAdapterErrorCategory = typeof harnessAdapterErrorCategories[number];

export type HarnessDelegation = {
  id: string;
  agent: string;
  mode: AgentExecutionMode;
  purpose: string;
  retryLimit: number;
};

export type HarnessInteraction = {
  id: string;
  operation: string;
  purpose: string;
  options: Array<{ id: string; label: string; description: string }>;
};

export type HarnessDriverEngine = {
  operations: string[];
  interactions: HarnessInteraction[];
  delegations: HarnessDelegation[];
};

export type HarnessDriverAgent = {
  operations: string[];
  defaultMode: AgentExecutionMode;
};

export type HarnessDriverContract = {
  schema: "prism-driver-contract/v1";
  id: string;
  version: string;
  engines: Record<string, HarnessDriverEngine>;
  agents: Record<string, HarnessDriverAgent>;
};

export type HarnessHostAdapter = {
  schema: "prism-host-adapter/v1";
  id: string;
  version: string;
  targetHost: string;
  operationBindings: Record<string, Record<string, unknown>>;
  interactionBindings: Record<string, { header?: string }>;
};

export type HarnessRuntimeContext = {
  packId: string;
  packVersion: string;
  sourceCommit: string;
  manifestSha256: string;
  driver: HarnessDriverContract;
  adapter: HarnessHostAdapter;
  quality?: QualityRuntimeContext;
};

export type BoundHarnessDelegation = HarnessDelegation & {
  parentEngine: EngineId;
  packId: string;
  packVersion: string;
  driverId: string;
  driverVersion: string;
};

export type HarnessDelegationDecision = {
  interactionId: string;
  question: UserQuestionRequest;
  failed: {
    runId: string;
    handle: string;
    delegation: BoundHarnessDelegation & { attempt: number };
    errorCategory: HarnessAdapterErrorCategory;
  };
};

export type HarnessDelegationFailureInteraction = Pick<HarnessDelegationDecision, "interactionId" | "question">;

const maxHarnessDelegationRetries = 3;

export class HarnessAdapterError extends Error {
  constructor(
    readonly category: HarnessAdapterErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "HarnessAdapterError";
  }
}

export function parseHarnessDriverContract(value: unknown): HarnessDriverContract {
  const raw = readObject(value, "Harness Driver Contract");
  const schema = readString(raw.schema, "Harness Driver Contract schema");
  if (schema !== "prism-driver-contract/v1") throw new Error(`Unsupported Harness Driver Contract schema "${schema}".`);
  const agentsRaw = readObject(raw.agents, "Harness Driver Contract agents");
  const enginesRaw = readObject(raw.engines, "Harness Driver Contract engines");
  const agents = Object.fromEntries(Object.entries(agentsRaw).map(([id, entry]) => {
    assertId(id, "Agent");
    const agent = readObject(entry, `Harness Driver Agent ${id}`);
    return [id, {
      operations: readStringList(agent.operations, `Harness Driver Agent ${id} operations`),
      defaultMode: readMode(agent.defaultMode, `Harness Driver Agent ${id} defaultMode`),
    }];
  }));
  const delegationIds = new Set<string>();
  const engines = Object.fromEntries(Object.entries(enginesRaw).map(([id, entry]) => {
    const engine = readObject(entry, `Harness Driver Engine ${id}`);
    const delegations = readList(engine.delegations, `Harness Driver Engine ${id} delegations`).map((item, index) => {
      const delegation = readObject(item, `Harness Driver Engine ${id} delegation ${index + 1}`);
      const parsed: HarnessDelegation = {
        id: readString(delegation.id, `Harness Driver Engine ${id} delegation id`),
        agent: readString(delegation.agent, `Harness Driver Engine ${id} delegation agent`),
        mode: readMode(delegation.mode, `Harness Driver Engine ${id} delegation mode`),
        purpose: readString(delegation.purpose, `Harness Driver Engine ${id} delegation purpose`),
        retryLimit: readNonNegativeInteger(delegation.retryLimit, `Harness Driver Engine ${id} delegation retryLimit`),
      };
      if (delegationIds.has(parsed.id)) throw new Error(`Harness Driver Contract contains duplicate delegation id "${parsed.id}".`);
      delegationIds.add(parsed.id);
      return parsed;
    });
    const interactionIds = new Set<string>();
    const interactions = readList(engine.interactions, `Harness Driver Engine ${id} interactions`).map((item, index) => {
      const interaction = readObject(item, `Harness Driver Engine ${id} interaction ${index + 1}`);
      const interactionId = readString(interaction.id, `Harness Driver Engine ${id} interaction id`);
      if (interactionIds.has(interactionId)) throw new Error(`Harness Driver Engine ${id} contains duplicate interaction id "${interactionId}".`);
      interactionIds.add(interactionId);
      const options = readList(interaction.options ?? [], `Harness Driver Engine ${id} interaction options`).map((option, optionIndex) => {
        const parsed = readObject(option, `Harness Driver Engine ${id} interaction option ${optionIndex + 1}`);
        return {
          id: readString(parsed.id, `Harness Driver Engine ${id} interaction option id`),
          label: readString(parsed.label, `Harness Driver Engine ${id} interaction option label`),
          description: readString(parsed.description, `Harness Driver Engine ${id} interaction option description`),
        };
      });
      if (new Set(options.map((option) => option.id)).size !== options.length) {
        throw new Error(`Harness Driver Engine ${id} interaction ${interactionId} contains duplicate option ids.`);
      }
      return {
        id: interactionId,
        operation: readString(interaction.operation, `Harness Driver Engine ${id} interaction operation`),
        purpose: readString(interaction.purpose, `Harness Driver Engine ${id} interaction purpose`),
        options,
      };
    });
    return [id, {
      operations: readStringList(engine.operations, `Harness Driver Engine ${id} operations`),
      delegations,
      interactions,
    }];
  }));
  return {
    schema,
    id: readString(raw.id, "Harness Driver Contract id"),
    version: readString(raw.version, "Harness Driver Contract version"),
    engines,
    agents,
  };
}

export function parseHarnessHostAdapter(value: unknown): HarnessHostAdapter {
  const raw = readObject(value, "Harness Host Adapter");
  const schema = readString(raw.schema, "Harness Host Adapter schema");
  if (schema !== "prism-host-adapter/v1") throw new Error(`Unsupported Harness Host Adapter schema "${schema}".`);
  const operationBindingsRaw = readObject(raw.operationBindings, "Harness Host Adapter operationBindings");
  const interactionBindingsRaw = readObject(raw.interactionBindings ?? {}, "Harness Host Adapter interactionBindings");
  return {
    schema,
    id: readString(raw.id, "Harness Host Adapter id"),
    version: readString(raw.version, "Harness Host Adapter version"),
    targetHost: readString(raw.targetHost, "Harness Host Adapter targetHost"),
    operationBindings: Object.fromEntries(Object.entries(operationBindingsRaw).map(([operation, binding]) => [
      operation,
      readObject(binding, `Harness Host Adapter operation binding ${operation}`),
    ])),
    interactionBindings: Object.fromEntries(Object.entries(interactionBindingsRaw).map(([id, value]) => {
      const binding = readObject(value, `Harness Host Adapter interaction binding ${id}`);
      return [id, { ...(binding.header === undefined ? {} : { header: readString(binding.header, `Harness Host Adapter interaction binding ${id} header`) }) }];
    })),
  };
}

export function validateHarnessDelegationContract(
  contract: HarnessDriverContract,
  adapter: HarnessHostAdapter,
  engineIds: readonly string[],
  agentIds: readonly string[],
): void {
  const knownEngines = new Set(engineIds);
  const knownAgents = new Set(agentIds);
  const contractAgents = Object.keys(contract.agents).sort();
  if (!sameList(contractAgents, [...knownAgents].sort())) {
    throw new Error("Harness Driver Contract Agent inventory does not match Harness Agent profile bindings.");
  }
  for (const [engineId, engine] of Object.entries(contract.engines)) {
    if (!knownEngines.has(engineId)) throw new Error(`Harness Driver Contract references unknown Engine "${engineId}".`);
    if (engine.delegations.length === 0) continue;
    if (!engine.operations.includes("agent.delegate")) {
      throw new Error(`Harness Driver Engine ${engineId} declares delegations without agent.delegate.`);
    }
    const agents = new Set<string>();
    for (const delegation of engine.delegations) {
      if (!knownAgents.has(delegation.agent)) {
        throw new Error(`Harness delegation ${delegation.id} references unknown Agent "${delegation.agent}".`);
      }
      if (agents.has(delegation.agent)) {
        throw new Error(`Harness Driver Engine ${engineId} has ambiguous delegations for Agent "${delegation.agent}".`);
      }
      agents.add(delegation.agent);
      if (contract.agents[delegation.agent]?.defaultMode !== delegation.mode) {
        throw new Error(`Harness delegation ${delegation.id} mode does not match Agent ${delegation.agent} defaultMode.`);
      }
    }
    const decisionId = `${engineId}.agent-failure`;
    const decision = engine.interactions.find((interaction) => interaction.id === decisionId);
    if (!decision || decision.operation !== "interaction.select" || decision.options.length < 2 || decision.options.length > 4) {
      throw new Error(`Harness Driver Engine ${engineId} must declare the ${decisionId} user decision point.`);
    }
    if (!decision.options.some((option) => option.id === "retry")) {
      throw new Error(`Harness Driver Engine ${engineId} failure decision must declare the retry option.`);
    }
    if (!adapter.interactionBindings[decisionId]?.header) {
      throw new Error(`Harness Host Adapter must bind a header for ${decisionId}.`);
    }
  }
  const hasDelegations = Object.values(contract.engines).some((engine) => engine.delegations.length > 0);
  const delegateBinding = adapter.operationBindings["agent.delegate"];
  if (hasDelegations && (!delegateBinding || delegateBinding.kind !== "interaction-tool" || delegateBinding.tool !== "spawn_agent")) {
    throw new Error("Harness Host Adapter agent.delegate must bind to spawn_agent.");
  }
  const selectBinding = adapter.operationBindings["interaction.select"];
  if (hasDelegations && (!selectBinding || selectBinding.kind !== "interaction-tool" || selectBinding.tool !== "ask_user_question")) {
    throw new Error("Harness Host Adapter interaction.select must bind to ask_user_question.");
  }
}

export function bindHarnessDelegation(
  runtime: HarnessRuntimeContext,
  parentEngine: EngineId,
  requestedAgent: string,
  requestedMode?: AgentExecutionMode,
): BoundHarnessDelegation {
  const engine = runtime.driver.engines[parentEngine];
  if (!engine) throw new HarnessAdapterError("unsupported", `Harness Driver does not declare Engine "${parentEngine}".`);
  const matches = engine.delegations.filter((delegation) => delegation.agent === requestedAgent);
  if (matches.length === 0) {
    throw new HarnessAdapterError("invalid_request", `Engine "${parentEngine}" does not declare delegation to Agent "${requestedAgent}".`);
  }
  if (matches.length > 1) {
    throw new HarnessAdapterError("conflict", `Engine "${parentEngine}" has ambiguous delegations to Agent "${requestedAgent}".`);
  }
  const delegation = matches[0]!;
  if (requestedMode && requestedMode !== delegation.mode) {
    throw new HarnessAdapterError("invalid_request", `Delegation ${delegation.id} fixes mode to ${delegation.mode}; requested ${requestedMode} is not allowed.`);
  }
  return {
    ...delegation,
    parentEngine,
    packId: runtime.packId,
    packVersion: runtime.packVersion,
    driverId: runtime.driver.id,
    driverVersion: runtime.driver.version,
  };
}

export function harnessDelegationFailureDecision(
  runtime: HarnessRuntimeContext,
  parentEngine: EngineId,
  failed: HarnessDelegationDecision["failed"],
): HarnessDelegationDecision {
  return {
    ...harnessDelegationFailureInteraction(runtime, parentEngine),
    failed,
  };
}

export function harnessDelegationFailureInteraction(
  runtime: HarnessRuntimeContext,
  parentEngine: EngineId,
): HarnessDelegationFailureInteraction {
  const interactionId = `${parentEngine}.agent-failure`;
  const interaction = runtime.driver.engines[parentEngine]?.interactions.find((candidate) => candidate.id === interactionId);
  if (!interaction || interaction.operation !== "interaction.select") {
    throw new HarnessAdapterError("unsupported", `Harness Driver does not declare ${interactionId}.`);
  }
  return {
    interactionId,
    question: {
      header: runtime.adapter.interactionBindings[interactionId]?.header ?? "SubAgent failure",
      question: interaction.purpose,
      options: interaction.options.map((option) => ({ id: option.id, label: option.label, description: option.description, kind: "model" })),
    },
  };
}

export function parseHarnessDelegationDecision(value: unknown): HarnessDelegationDecision {
  const raw = readObject(value, "Harness delegation decision");
  const questionRaw = readObject(raw.question, "Harness delegation decision question");
  const failedRaw = readObject(raw.failed, "Harness delegation decision failed run");
  const delegationRaw = readObject(failedRaw.delegation, "Harness delegation decision binding");
  const parentEngine = readString(delegationRaw.parentEngine, "Harness delegation decision parentEngine");
  if (!(engineIds as readonly string[]).includes(parentEngine)) {
    throw new Error(`Harness delegation decision parentEngine is invalid: ${parentEngine}.`);
  }
  const errorCategory = readString(failedRaw.errorCategory, "Harness delegation decision errorCategory");
  if (!(harnessAdapterErrorCategories as readonly string[]).includes(errorCategory)) {
    throw new Error(`Harness delegation decision errorCategory is invalid: ${errorCategory}.`);
  }
  const options = readList(questionRaw.options, "Harness delegation decision options").map((value, index) => {
    const option = readObject(value, `Harness delegation decision option ${index + 1}`);
    return {
      id: readString(option.id, `Harness delegation decision option ${index + 1} id`),
      label: readString(option.label, `Harness delegation decision option ${index + 1} label`),
      description: readString(option.description, `Harness delegation decision option ${index + 1} description`),
      kind: "model" as const,
    };
  });
  if (options.length < 2 || options.length > 4 || new Set(options.map((option) => option.id)).size !== options.length) {
    throw new Error("Harness delegation decision must contain 2 to 4 unique Contract options.");
  }
  return {
    interactionId: readString(raw.interactionId, "Harness delegation decision interactionId"),
    question: {
      header: readString(questionRaw.header, "Harness delegation decision question header"),
      question: readString(questionRaw.question, "Harness delegation decision question text"),
      options,
    },
    failed: {
      runId: readString(failedRaw.runId, "Harness delegation decision runId"),
      handle: readString(failedRaw.handle, "Harness delegation decision handle"),
      errorCategory: errorCategory as HarnessAdapterErrorCategory,
      delegation: {
        id: readString(delegationRaw.id, "Harness delegation decision id"),
        agent: readString(delegationRaw.agent, "Harness delegation decision agent"),
        mode: readMode(delegationRaw.mode, "Harness delegation decision mode"),
        purpose: readString(delegationRaw.purpose, "Harness delegation decision purpose"),
        retryLimit: readNonNegativeInteger(delegationRaw.retryLimit, "Harness delegation decision retryLimit"),
        attempt: readPositiveInteger(delegationRaw.attempt, "Harness delegation decision attempt"),
        parentEngine: parentEngine as EngineId,
        packId: readString(delegationRaw.packId, "Harness delegation decision packId"),
        packVersion: readString(delegationRaw.packVersion, "Harness delegation decision packVersion"),
        driverId: readString(delegationRaw.driverId, "Harness delegation decision driverId"),
        driverVersion: readString(delegationRaw.driverVersion, "Harness delegation decision driverVersion"),
      },
    },
  };
}

export function normalizeHarnessAdapterError(error: unknown): HarnessAdapterError {
  if (error instanceof HarnessAdapterError) return error;
  if (error instanceof ProviderError) {
    if (error.status === 401 || error.status === 403) return new HarnessAdapterError("denied", error.message);
    if (error.status === 404) return new HarnessAdapterError("not_found", error.message);
    if (error.status === 409) return new HarnessAdapterError("conflict", error.message);
    if (error.kind === "missing_credentials" || error.kind === "malformed_response") {
      return new HarnessAdapterError("failed", error.message);
    }
    if (error.status !== undefined && isRetryableStatus(error.status)) {
      return new HarnessAdapterError("transient", error.message);
    }
    if (error.retryable) return new HarnessAdapterError("transient", error.message);
    return new HarnessAdapterError("failed", error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const category: HarnessAdapterErrorCategory =
    /permission denied|permission rejected|\bdenied\b/.test(lower) ? "denied"
      : /not found|missing|cannot access|enoent/.test(lower) ? "not_found"
        : /conflict|already owned|overlapping path/.test(lower) ? "conflict"
          : /timeout|timed out|rate limit|network|temporar|unavailable/.test(lower) ? "transient"
            : /unsupported|not implemented/.test(lower) ? "unsupported"
              : /invalid|malformed|must |unknown agent|not declare/.test(lower) ? "invalid_request"
                : "failed";
  return new HarnessAdapterError(category, message);
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function readList(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function readStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be a list of non-empty strings.`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new Error(`${label} must contain unique values.`);
  return result;
}

function readMode(value: unknown, label: string): AgentExecutionMode {
  if (value !== "foreground" && value !== "background") throw new Error(`${label} must be foreground or background.`);
  return value;
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer.`);
  if (Number(value) > maxHarnessDelegationRetries) {
    throw new Error(`${label} exceeds the host maximum of ${maxHarnessDelegationRetries}.`);
  }
  return Number(value);
}

function readPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer.`);
  return Number(value);
}

function assertId(value: string, label: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error(`${label} id "${value}" is invalid.`);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
