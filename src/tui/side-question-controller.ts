// `/btw` side-question TUI controller. Owns the per-session in-memory exchange
// list, the overlay open/index state, a side-specific AbortController kept
// outside the main cancellable turn controller, and the keyboard/scroll state
// for the overlay. Exchanges are ephemeral: they survive dismiss/reopen and an
// in-process session switch back, but never survive a process restart and
// never enter session JSONL or the main transcript.

import { createSignal, type Accessor, type Setter } from "solid-js";
import type { ProviderSelection } from "../config/providers";
import type { EngineId } from "../core/engine/profile";
import { askSideQuestion, resolveSideQuestionSnapshot } from "../core/side-question/service";
import { cloneSideQuestionMessages, type SideQuestionContextSnapshot } from "../core/side-question/types";
import type { ReasoningTier, ResponseUsage, VesicleMessage } from "../providers/shared/types";
import type { TuiKeyEvent } from "./decision-interaction";

export type SideQuestionExchange = {
  id: string;
  sessionId: string;
  question: string;
  answer: string;
  phase: "loading" | "complete" | "error" | "cancelled";
  error?: string;
  usage?: ResponseUsage;
};

export type SideQuestionOverlayState = {
  sessionId: string;
  exchangeIndex: number;
};

export type SideQuestionControllerOptions = {
  rootDir: string;
  sessionId: Accessor<string | undefined>;
  conversation: Accessor<VesicleMessage[]>;
  activeEngine: Accessor<EngineId>;
  activeProviderSelection: () => ProviderSelection;
  activeReasoningTier: Accessor<ReasoningTier | undefined>;
  mainStatus: Accessor<string>;
  mainActive: Accessor<boolean>;
  setStatus: Setter<string>;
  copyText: (text: string) => Promise<boolean>;
};

const NOT_STARTED_MESSAGE = "Side questions are available after the session starts.";

export function createSideQuestionController(options: SideQuestionControllerOptions) {
  const exchanges = new Map<string, SideQuestionExchange[]>();
  const snapshots = new Map<string, SideQuestionContextSnapshot>();
  // Sessions that have published at least one provider-valid context boundary
  // (or been resumed). `/btw` stays "not started" until a session is ready.
  const readySessions = new Set<string>();
  const [overlay, setOverlay] = createSignal<SideQuestionOverlayState | null>(null);
  const [exchangeVersions, setExchangeVersions] = createSignal(0);
  const [scrollOffset, setScrollOffset] = createSignal(0);
  let sideController: AbortController | null = null;

  function captureSnapshot(snapshot: SideQuestionContextSnapshot): void {
    readySessions.add(snapshot.sessionId);
    snapshots.set(snapshot.sessionId, snapshot);
  }

  async function rebuildForResume(sessionId: string): Promise<void> {
    readySessions.add(sessionId);
    const snapshot = await resolveSideQuestionSnapshot({
      rootDir: options.rootDir,
      sessionId,
      engine: options.activeEngine(),
      providerSelection: options.activeProviderSelection(),
      reasoningTier: options.activeReasoningTier(),
    }).catch(() => undefined);
    if (snapshot) snapshots.set(sessionId, snapshot);
  }

  /**
   * Resolve the snapshot a side request should replay. While the main Agent
   * Loop is busy the cached provider-boundary snapshot is authoritative. When
   * idle, host actions (/model, /engine, /effort, /compact, /rewind) may have
   * changed the active settings or the conversation since the last boundary, so
   * rebuild when the cached settings are stale and otherwise refresh messages
   * from the live conversation using a full-fidelity clone.
   */
  async function resolveEffectiveSnapshot(sessionId: string): Promise<SideQuestionContextSnapshot | undefined> {
    const cached = snapshots.get(sessionId);
    if (options.mainActive() && cached) return cached;
    if (!cached || settingsStale(cached)) {
      const rebuilt = await resolveSideQuestionSnapshot({
        rootDir: options.rootDir,
        sessionId,
        engine: options.activeEngine(),
        providerSelection: options.activeProviderSelection(),
        reasoningTier: options.activeReasoningTier(),
      }).catch(() => undefined);
      if (rebuilt) {
        snapshots.set(sessionId, rebuilt);
        return rebuilt;
      }
      return cached;
    }
    return { ...cached, messages: cloneSideQuestionMessages(options.conversation()) };
  }

  function settingsStale(cached: SideQuestionContextSnapshot): boolean {
    const selection = options.activeProviderSelection();
    if (cached.providerSelection.provider !== selection.provider) return true;
    if (cached.providerSelection.model !== selection.model) return true;
    if (cached.engine !== options.activeEngine()) return true;
    if ((cached.generation?.reasoningTier ?? undefined) !== options.activeReasoningTier()) return true;
    return false;
  }

  function sessionExchanges(id: string): SideQuestionExchange[] {
    return exchanges.get(id) ?? [];
  }

  function currentExchange(): SideQuestionExchange | undefined {
    // Subscribe reactive callers (overlay rendering) to exchange mutations.
    exchangeVersions();
    const state = overlay();
    if (!state) return undefined;
    return sessionExchanges(state.sessionId).at(state.exchangeIndex);
  }

  async function openSideQuestion(args: string): Promise<void> {
    const id = options.sessionId();
    if (!id) {
      options.setStatus(NOT_STARTED_MESSAGE);
      return;
    }
    const trimmed = args.trim();
    if (!trimmed) {
      const prior = sessionExchanges(id);
      if (prior.length > 0) {
        resetScrollFor(prior.length - 1);
        setOverlay({ sessionId: id, exchangeIndex: prior.length - 1 });
      } else {
        options.setStatus("Usage: /btw <question>");
      }
      return;
    }
    if (!readySessions.has(id)) {
      options.setStatus(NOT_STARTED_MESSAGE);
      return;
    }
    // Only one side request may be active at a time.
    abortSide();
    const exchange: SideQuestionExchange = {
      id: `${id}:btw:${crypto.randomUUID()}`,
      sessionId: id,
      question: trimmed,
      answer: "",
      phase: "loading",
    };
    const list = [...sessionExchanges(id), exchange];
    exchanges.set(id, list);
    bumpExchangeVersion();
    const index = list.length - 1;
    resetScrollFor(index);
    setOverlay({ sessionId: id, exchangeIndex: index });
    void runSideRequest(id, exchange);
  }

  async function runSideRequest(sessionId: string, exchange: SideQuestionExchange): Promise<void> {
    const snapshot = await resolveEffectiveSnapshot(sessionId);
    if (!snapshot) {
      mutateExchange(sessionId, exchange.id, { phase: "error", error: NOT_STARTED_MESSAGE });
      return;
    }
    const controller = new AbortController();
    sideController = controller;
    try {
      const result = await askSideQuestion({
        rootDir: options.rootDir,
        context: snapshot,
        question: exchange.question,
        signal: controller.signal,
        onDelta: (delta) => {
          mutateExchange(sessionId, exchange.id, (current) => ({ ...current, answer: `${current.answer}${delta}` }));
        },
      });
      mutateExchange(sessionId, exchange.id, {
        phase: "complete",
        answer: result.content,
        ...(result.usage ? { usage: result.usage } : {}),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        mutateExchange(sessionId, exchange.id, { phase: "cancelled" });
      } else {
        // Keep the failure inside the ephemeral exchange only. Do not route it
        // through the main turn's reportError, which would write an assistant
        // error message into the main transcript and violate /btw isolation.
        const message = error instanceof Error ? error.message : String(error);
        mutateExchange(sessionId, exchange.id, { phase: "error", error: message });
      }
    } finally {
      if (sideController === controller) sideController = null;
    }
  }

  function abortSide(): void {
    sideController?.abort("side-cancel");
    sideController = null;
  }

  function mutateExchange(
    sessionId: string,
    exchangeId: string,
    update: Partial<SideQuestionExchange> | ((current: SideQuestionExchange) => SideQuestionExchange),
  ): void {
    const list = exchanges.get(sessionId);
    if (!list) return;
    exchanges.set(sessionId, list.map((entry) => entry.id === exchangeId
      ? typeof update === "function" ? update(entry) : { ...entry, ...update }
      : entry));
    bumpExchangeVersion();
  }

  function bumpExchangeVersion(): void {
    setExchangeVersions((value) => value + 1);
  }

  function resetScrollFor(_index: number): void {
    setScrollOffset(0);
  }

  function close(): void {
    abortSide();
    setOverlay(null);
  }

  function clearCurrent(): void {
    const state = overlay();
    if (!state) return;
    exchanges.delete(state.sessionId);
    bumpExchangeVersion();
    abortSide();
    setOverlay(null);
  }

  async function copyCurrent(): Promise<void> {
    const exchange = currentExchange();
    if (!exchange || exchange.phase !== "complete") return;
    const copied = await options.copyText(exchange.answer);
    options.setStatus(copied ? "side answer copied" : "copy failed");
  }

  function handleKey(key: TuiKeyEvent): boolean {
    const state = overlay();
    if (!state) return false;
    const exchange = currentExchange();
    const name = key.name?.toLowerCase();
    const phase = exchange?.phase;

    if (phase === "loading") {
      if (name === "escape") { close(); return true; }
      return true;
    }

    switch (name) {
      case "escape":
      case "space":
      case "return":
      case "enter":
        close();
        return true;
      case "up":
        setScrollOffset((offset) => Math.max(0, offset - 1));
        return true;
      case "down":
        setScrollOffset((offset) => offset + 1);
        return true;
      case "left":
        navigate(state, -1);
        return true;
      case "right":
        navigate(state, 1);
        return true;
      case "c":
        void copyCurrent();
        return true;
      case "x":
        clearCurrent();
        return true;
      default:
        return true;
    }
  }

  function navigate(state: SideQuestionOverlayState, delta: number): void {
    const list = sessionExchanges(state.sessionId);
    const next = Math.max(0, Math.min(list.length - 1, state.exchangeIndex + delta));
    resetScrollFor(next);
    setOverlay({ sessionId: state.sessionId, exchangeIndex: next });
  }

  function mainStatusText(): string {
    return options.mainActive() ? `Main: ${options.mainStatus()}` : "Main: idle";
  }

  function dispose(): void {
    abortSide();
  }

  // exchangeVersions is read in the overlay to re-render on async updates.
  void exchangeVersions;

  return {
    overlay,
    setOverlay,
    scrollOffset,
    sessionExchanges,
    currentExchange,
    exchangeVersions,
    captureSnapshot,
    rebuildForResume,
    openSideQuestion,
    handleKey,
    mainStatusText,
    dispose,
  };
}
