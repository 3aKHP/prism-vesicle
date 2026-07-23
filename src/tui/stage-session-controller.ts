import { startStageSession, type StartStageSessionOptions, type StartedStageSession } from "../core/stage/bootstrap";
import type { EngineId } from "../core/engine/profile";
import type { PermissionMode } from "../core/permissions";
import type { ReasoningTier, VesicleMessage } from "../providers/shared/types";
import type { PendingEngineSwitchState, PendingGateState, PendingPermissionState, PendingQualityDecisionState, PendingUserQuestionState } from "./decision-interaction";
import type { ActivityEntry, Message } from "./types";
import type { TokenUsageSummary } from "./telemetry";

type StageSessionControllerOptions = {
  rootDir: string;
  activeProvider: () => string;
  activeModel: () => string;
  permissionMode: () => PermissionMode;
  reasoningTier: () => ReasoningTier | undefined;
  clearQueuedInputs: () => void;
  setSessionId: (sessionId: string) => void;
  setSessionPath: (sessionPath: string) => void;
  setActiveEngine: (engine: EngineId) => void;
  setConversation: (messages: VesicleMessage[]) => void;
  setOutput: (output: string) => void;
  setLastTurnUsage: (usage: TokenUsageSummary | undefined) => void;
  setSessionUsage: (usage: TokenUsageSummary) => void;
  setNextSessionParent: (parent: null) => void;
  setPendingGate: (pending: PendingGateState | null) => void;
  setPendingEngineSwitch: (pending: PendingEngineSwitchState | null) => void;
  setPendingUserQuestion: (pending: PendingUserQuestionState | null) => void;
  setPendingPermission: (pending: PendingPermissionState | null) => void;
  setPendingQualityDecision: (pending: PendingQualityDecisionState | null) => void;
  setMessages: (messages: Message[]) => void;
  setStatus: (status: string) => void;
  recordActivity: (entry: ActivityEntry) => void;
  startSession?: (options: StartStageSessionOptions) => Promise<StartedStageSession>;
};

const emptyUsage: TokenUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  contextInputTokens: 0,
};

export function createStageSessionController(options: StageSessionControllerOptions) {
  async function start(characterPath: string, scenarioPath: string, commandEcho: string): Promise<void> {
    const provider = options.activeProvider();
    const started = await (options.startSession ?? startStageSession)({
      rootDir: options.rootDir,
      characterPath,
      scenarioPath,
      provider,
      providerId: provider,
      model: options.activeModel(),
      permissionMode: options.permissionMode(),
      reasoningTier: options.reasoningTier(),
    });
    applyStartedSession(started, commandEcho);
  }

  function applyStartedSession(started: StartedStageSession, commandEcho: string): void {
    options.clearQueuedInputs();
    options.setSessionId(started.sessionId);
    options.setSessionPath(started.sessionPath);
    options.setActiveEngine("stage");
    options.setConversation(started.messages);
    options.setOutput(started.opening);
    options.setLastTurnUsage(undefined);
    options.setSessionUsage(emptyUsage);
    options.setNextSessionParent(null);
    options.setPendingGate(null);
    options.setPendingEngineSwitch(null);
    options.setPendingUserQuestion(null);
    options.setPendingPermission(null);
    options.setPendingQualityDecision(null);
    options.setMessages([
      { role: "user", content: commandEcho },
      ...started.warnings.map((warning) => ({ role: "system" as const, content: `Stage card warning: ${warning}` })),
      { id: started.openingRecordUuid, role: "assistant", content: started.opening, kind: "stage-bootstrap-opening", engine: "stage" },
    ]);
    options.setStatus("Stage session ready");
    options.recordActivity({ kind: "system", text: `started Stage session ${started.sessionId}` });
  }

  return { start };
}
