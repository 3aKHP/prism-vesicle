import type { Accessor, Setter } from "solid-js";
import type { ProviderSelection } from "../config/providers";
import { compactConversation } from "../core/compact/service";
import { generateProjectInstructions } from "../core/init";
import type { EngineId } from "../core/engine/profile";
import type { ReasoningDisplayMode, SessionSummary } from "../core/session/store";
import type { ConversationRewind } from "../core/rewind/service";
import type { ReasoningTier, VesicleImageAttachment, VesicleMessage } from "../providers/shared/types";
import type { ComposerState } from "./composer";
import { composerElementsForImages } from "./composer-history";
import type { PendingEngineSwitchState, PendingGateState, PendingPermissionState, PendingQualityDecisionState, PendingUserQuestionState, TuiKeyEvent } from "./decision-interaction";
import { displayTranscriptFromSnapshot, vesicleMessagesFromResumed } from "./session-presenter";
import { latestTurnUsage, sumSessionUsage, type TokenUsageSummary } from "./telemetry";
import type { ActivityEntry, AgentCardState, Message, SessionPickerState } from "./types";

export type SessionActionsControllerOptions = {
  rootDir: string;
  sessionId: Accessor<string | undefined>;
  activeEngine: Accessor<EngineId>;
  setActiveEngine: Setter<EngineId>;
  activeProviderSelection: () => ProviderSelection;
  activeGeneration: () => { reasoningTier: ReasoningTier } | undefined;
  providerConfigReady: Accessor<boolean>;
  loadProviderConfig: () => Promise<void>;
  pendingGate: Accessor<PendingGateState | null>;
  setPendingGate: Setter<PendingGateState | null>;
  pendingEngineSwitch: Accessor<PendingEngineSwitchState | null>;
  setPendingEngineSwitch: Setter<PendingEngineSwitchState | null>;
  pendingUserQuestion: Accessor<PendingUserQuestionState | null>;
  setPendingUserQuestion: Setter<PendingUserQuestionState | null>;
  pendingPermission: Accessor<PendingPermissionState | null>;
  setPendingPermission: Setter<PendingPermissionState | null>;
  pendingQualityDecision: Accessor<PendingQualityDecisionState | null>;
  setPendingQualityDecision: Setter<PendingQualityDecisionState | null>;
  pendingChildPermission: Accessor<unknown | null>;
  agentCards: Accessor<AgentCardState[]>;
  setConversation: Setter<VesicleMessage[]>;
  setMessages: Setter<Message[]>;
  setThinkingTier: Setter<ReasoningTier | undefined>;
  setReasoningDisplayMode: Setter<ReasoningDisplayMode>;
  applyProviderSelection: (selection: Partial<ProviderSelection>) => Promise<ProviderSelection>;
  setOutput: Setter<string>;
  setNextSessionParent: Setter<{ uuid: string | null } | null>;
  applyComposerState: (state: ComposerState) => void;
  clearComposer: () => void;
  setInputImages: Setter<VesicleImageAttachment[]>;
  setHistoryIndex: Setter<number | null>;
  setLastTurnUsage: Setter<TokenUsageSummary | undefined>;
  setSessionUsage: Setter<TokenUsageSummary>;
  sessionPicker: Accessor<SessionPickerState | null>;
  setSessionPicker: Setter<SessionPickerState | null>;
  setBusy: Setter<boolean>;
  setStatus: Setter<string>;
  recordActivity: (entry: ActivityEntry) => void;
  runCancellable: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<{ kind: "complete"; value: T } | { kind: "interrupted" }>;
  rewindReset: () => void;
  refreshArtifacts: () => Promise<unknown>;
  resumeSession: (target: SessionSummary) => Promise<void>;
};

export function createSessionActionsController(options: SessionActionsControllerOptions) {
  function resetRewindState(): void {
    options.rewindReset();
    options.setNextSessionParent(null);
  }

  async function applyConversationRewind(result: ConversationRewind): Promise<void> {
    const snapshot = result.snapshot;
    options.setConversation(vesicleMessagesFromResumed(snapshot.messages));
    options.setMessages(displayTranscriptFromSnapshot(snapshot.messages, options.agentCards()));
    options.setActiveEngine(snapshot.engine ?? "etl");
    options.setThinkingTier(snapshot.reasoningTier);
    options.setReasoningDisplayMode(snapshot.reasoningDisplayMode ?? "collapsed");
    if (snapshot.providerSelection) {
      try {
        await options.applyProviderSelection(snapshot.providerSelection);
      } catch (error) {
        options.recordActivity({ kind: "system", text: `rewind kept current provider: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    clearPendingInteractions();
    options.setOutput("");
    options.setNextSessionParent({ uuid: result.parentUuid });
    const images = result.images ?? [];
    options.applyComposerState({
      value: result.prompt,
      cursor: result.prompt.length,
      elements: composerElementsForImages(result.prompt, images),
    });
    options.setInputImages(images.map((image) => ({ ...image })));
    options.setHistoryIndex(null);
    await options.refreshArtifacts();
    options.setStatus("conversation rewound");
  }

  async function compactSession(instructions?: string): Promise<{ summary: string; messagesSummarized: number }> {
    const id = options.sessionId();
    if (!id) throw new Error("No active session to compact.");
    if (hasPendingInteraction()) throw new Error("Resolve the pending gate, engine switch, question, permission, or quality decision before compacting.");
    if (!options.providerConfigReady()) await options.loadProviderConfig();
    options.setBusy(true);
    options.setStatus("compacting conversation");
    options.recordActivity({ kind: "provider", text: "compacting conversation" });
    try {
      const outcome = await options.runCancellable((signal) => compactConversation({
        rootDir: options.rootDir,
        sessionId: id,
        engine: options.activeEngine(),
        providerSelection: options.activeProviderSelection(),
        generation: options.activeGeneration(),
        instructions,
        signal,
      }));
      if (outcome.kind === "interrupted") throw new Error("Compaction canceled.");
      const result = outcome.value;
      const snapshot = result.snapshot;
      options.setConversation(vesicleMessagesFromResumed(snapshot.messages));
      options.setMessages(displayTranscriptFromSnapshot(snapshot.messages, options.agentCards()));
      options.setLastTurnUsage(latestTurnUsage(snapshot.messages));
      options.setSessionUsage(sumSessionUsage(snapshot.messages));
      options.setOutput("");
      options.setNextSessionParent({ uuid: result.parentUuid });
      clearPendingInteractions();
      options.setSessionPicker(null);
      options.rewindReset();
      options.clearComposer();
      options.setHistoryIndex(null);
      options.setStatus(`compacted ${result.messagesSummarized} messages`);
      options.recordActivity({ kind: "system", text: `compacted ${result.messagesSummarized} messages` });
      return { summary: result.summary, messagesSummarized: result.messagesSummarized };
    } finally {
      options.setBusy(false);
    }
  }

  async function initProject(notes?: string): Promise<{ path: string; overwritten: boolean }> {
    if (hasPendingInteraction()) throw new Error("Resolve the pending gate, engine switch, question, permission, or quality decision before running /init.");
    if (!options.providerConfigReady()) await options.loadProviderConfig();
    options.setBusy(true);
    options.setStatus("initializing project");
    options.recordActivity({ kind: "provider", text: "generating VESICLE.md" });
    try {
      const outcome = await options.runCancellable((signal) => generateProjectInstructions({
        rootDir: options.rootDir,
        providerSelection: options.activeProviderSelection(),
        generation: options.activeGeneration(),
        notes,
        signal,
      }));
      if (outcome.kind === "interrupted") throw new Error("/init canceled.");
      const result = outcome.value;
      const backup = result.backupPath ? ` The previous version was backed up to ${result.backupPath}.` : "";
      const priorWarn = result.backupReplacedPrior ? " That backup path already held an earlier backup, which it replaced." : "";
      const overrides = result.maskedByEngineOverrides ?? [];
      const masked = overrides.length
        ? ` Engine-specific override file(s) (${overrides.map((engine) => `VESICLE.${engine}.md`).join(", ")}) take precedence for those engines, so this general file is masked there.`
        : "";
      const effect = overrides.length
        ? "It takes effect on the next turn for engines without an override"
        : "It takes effect on the next turn";
      options.setMessages((previous) => [...previous, {
        role: "system",
        content: `Generated ${result.path} from the project scan.${backup}${priorWarn} ${effect} — review and edit it as needed.${masked}`,
      }]);
      options.setStatus("VESICLE.md generated");
      options.recordActivity({ kind: "system", text: `VESICLE.md generated${result.overwritten ? " (replaced existing)" : ""}` });
      return { path: result.path, overwritten: result.overwritten };
    } finally {
      options.setBusy(false);
    }
  }

  function handleSessionPickerKey(key: TuiKeyEvent): boolean {
    const picker = options.sessionPicker();
    if (!picker) return false;
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      options.setSessionPicker({ ...picker, selected: (picker.selected - 1 + picker.sessions.length) % picker.sessions.length });
      return true;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      options.setSessionPicker({ ...picker, selected: (picker.selected + 1) % picker.sessions.length });
      return true;
    }
    if (key.name === "return" || key.name === "enter") {
      const target = picker.sessions[picker.selected];
      if (target) void options.resumeSession(target);
      return true;
    }
    if (key.name === "escape") {
      options.setSessionPicker(null);
      options.setStatus("resume cancelled");
      return true;
    }
    return false;
  }

  function clearPendingInteractions(): void {
    options.setPendingGate(null);
    options.setPendingEngineSwitch(null);
    options.setPendingUserQuestion(null);
    options.setPendingPermission(null);
    options.setPendingQualityDecision(null);
  }

  function hasPendingInteraction(): boolean {
    return Boolean(options.pendingGate() || options.pendingEngineSwitch() || options.pendingUserQuestion() || options.pendingPermission() || options.pendingQualityDecision() || options.pendingChildPermission());
  }

  return { applyConversationRewind, compactSession, initProject, handleSessionPickerKey, resetRewindState };
}
