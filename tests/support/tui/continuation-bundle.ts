import type { Setter } from "solid-js";
import type { AgentManager } from "../../../src/core/agents/manager";
import type { ToolPermissionBroker } from "../../../src/core/permissions";
import type { EngineId } from "../../../src/core/engine/profile";
import type { GateFocusTarget } from "../../../src/tui/GatePrompt";
import type { PendingEngineSwitchState, PendingGateState, PendingPermissionState, PendingQualityDecisionState, PendingUserQuestionState } from "../../../src/tui/decision-interaction";
import type { AgentCardState, Message, SessionPickerState } from "../../../src/tui/types";
import type { VesicleMessage } from "../../../src/providers/shared/types";
import type { DecisionContinuationBundle } from "../../../src/tui/decision-continuations";
import type { PermissionContext } from "../../../src/tui/turn-controller-options";
import type { QueuedWorkController } from "../../../src/tui/queued-work-controller";

/**
 * Shared, typed continuation-bundle fixture. `makeContinuationBundle` returns
 * a fully typed `DecisionContinuationBundle` with inert-but-conforming
 * defaults, so the port boundary this helper exists to verify is enforced by
 * the type system rather than by `as any` casts at the call sites. Tests
 * override only the port members they observe; the default `runCancellable`
 * never invokes the provider operation, so inert accessors are never read.
 */
export type ContinuationBundleOverrides = {
  [K in keyof DecisionContinuationBundle]?: DecisionContinuationBundle[K] extends (...args: never[]) => unknown
    ? DecisionContinuationBundle[K]
    : DecisionContinuationBundle[K] extends object
      ? Partial<DecisionContinuationBundle[K]>
      : DecisionContinuationBundle[K];
};

export function makeContinuationBundle(overrides: ContinuationBundleOverrides = {}): DecisionContinuationBundle {
  const noop = () => undefined;
  const base: DecisionContinuationBundle = {
    runtime: {
      dangerouslySkipPermissions: false,
      permissionMode: () => "MANUAL" as const,
      shellExecEnabled: () => false,
      shellInterpreter: () => "auto" as const,
      providerConfigReady: () => true,
      setProviderConfigReady: (() => undefined) as Setter<boolean>,
      loadProviderConfig: async () => undefined,
      permissionSettingsReady: () => true,
      loadPermissionSettings: async () => undefined,
      activeModelCapabilities: () => undefined,
      activeEngine: () => "etl" as const,
      setActiveEngine: (() => undefined) as Setter<EngineId>,
      activeModel: () => "unused",
      activeProviderSelection: () => ({ provider: "unused", model: "unused" }),
      activeGeneration: () => undefined,
      busy: () => false,
      setBusy: ((value: boolean) => value) as Setter<boolean>,
      permissionBroker: { resolve: () => true } as unknown as ToolPermissionBroker,
    },
    session: {
      rootDir: "",
      sessionId: () => undefined,
      setSessionId: (() => undefined) as Setter<string | undefined>,
      setSessionPath: (() => undefined) as Setter<string>,
      conversation: () => [] as VesicleMessage[],
      setConversation: (() => undefined) as Setter<VesicleMessage[]>,
      nextSessionParent: () => null,
      setNextSessionParent: (() => undefined) as Setter<{ uuid: string | null } | null>,
      setSessionPicker: (() => undefined) as Setter<SessionPickerState | null>,
    },
    transcript: {
      setMessages: (() => undefined) as Setter<Message[]>,
      setStatus: (() => undefined) as Setter<string>,
      setOutput: (() => undefined) as Setter<string>,
      setStreamingAssistant: (() => undefined) as Setter<string>,
      setStreamingReasoning: (() => undefined) as Setter<string>,
      lastDisplayedToolAssistantContent: () => null,
      setLastDisplayedToolAssistantContent: (() => undefined) as Setter<string | null>,
      recordActivity: noop,
    },
    decision: {
      pendingGate: () => null,
      setPendingGate: (() => undefined) as Setter<PendingGateState | null>,
      pendingEngineSwitch: () => null,
      setPendingEngineSwitch: (() => undefined) as Setter<PendingEngineSwitchState | null>,
      pendingUserQuestion: () => null,
      setPendingUserQuestion: (() => undefined) as Setter<PendingUserQuestionState | null>,
      pendingPermission: () => null,
      setPendingPermission: (() => undefined) as Setter<PendingPermissionState | null>,
      pendingQualityDecision: () => null,
      setPendingQualityDecision: (() => undefined) as Setter<PendingQualityDecisionState | null>,
      pendingChildPermission: () => null,
      questionSelected: () => 0,
      setQuestionSelected: (() => undefined) as Setter<number>,
      setQualitySelected: (() => undefined) as Setter<number>,
      questionFreeformText: () => "",
      clearQuestionFreeform: noop,
      setGateFocus: (() => undefined) as Setter<GateFocusTarget>,
      setGateFeedbackMode: (() => undefined) as Setter<GateFocusTarget | null>,
      clearGateFeedback: noop,
    },
    agent: {
      agentCards: () => [],
      setAgentCards: (() => undefined) as Setter<AgentCardState[]>,
      pausedAgentDeliveries: new Set<string>(),
      agentManager: (() => undefined) as unknown as () => AgentManager,
      handleAgentEvent: noop,
    },
    usage: {
      beginUsageTurn: noop,
      publishTurnUsage: noop,
      recordIndependentAgentUsage: noop,
    },
    hostAction: {
      refreshArtifacts: async () => [],
      refreshQualityWarnings: async () => [],
      resumeQualitySession: async () => undefined,
      compactSession: async () => ({ summary: "", messagesSummarized: 0 }),
      executeLocalCommand: async () => undefined,
    },
    queuedWork: {
      block: noop,
      release: noop,
      prepareTurn: noop,
      handleInterruption: async () => false,
      takePendingUserInputs: () => [],
      runToolBoundaryCommands: async () => undefined,
    } as unknown as QueuedWorkController,
    runCancellable: async () => ({ kind: "interrupted" }),
    handleResult: noop,
    handleInterruptedTurn: noop,
    reportError: noop,
    permissionContext: (): PermissionContext => ({ mode: "MANUAL", shellExecEnabled: false, shellInterpreter: "auto" }),
  };
  return {
    runtime: { ...base.runtime, ...overrides.runtime },
    session: { ...base.session, ...overrides.session },
    transcript: { ...base.transcript, ...overrides.transcript },
    decision: { ...base.decision, ...overrides.decision },
    agent: { ...base.agent, ...overrides.agent },
    usage: { ...base.usage, ...overrides.usage },
    hostAction: { ...base.hostAction, ...overrides.hostAction },
    queuedWork: { ...base.queuedWork, ...overrides.queuedWork },
    runCancellable: overrides.runCancellable ?? base.runCancellable,
    handleResult: overrides.handleResult ?? base.handleResult,
    handleInterruptedTurn: overrides.handleInterruptedTurn ?? base.handleInterruptedTurn,
    reportError: overrides.reportError ?? base.reportError,
    permissionContext: overrides.permissionContext ?? base.permissionContext,
    resolveQualityDecision: overrides.resolveQualityDecision ?? base.resolveQualityDecision,
  };
}

/**
 * Recording setter for fixtures: handles Solid's function-form updates and
 * logs every resolved plain value, so tests can assert the value sequence
 * with a fully typed `Setter<T>`.
 */
export function recordSetter<T>(log: T[]): Setter<T> {
  const set: (value: T | ((prev: T) => T)) => T = (value) => {
    const next = typeof value === "function" ? (value as (prev: T) => T)(log.at(-1) as T) : value;
    log.push(next);
    return next;
  };
  return set as Setter<T>;
}
