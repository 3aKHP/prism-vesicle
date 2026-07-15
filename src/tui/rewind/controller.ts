import { createSignal } from "solid-js";
import type { ProviderSelection } from "../../config/providers";
import type { EngineId } from "../../core/engine/profile";
import {
  listRewindPoints,
  rewindCode,
  rewindCodeAndConversation,
  rewindConversation,
  summarizeConversationFrom,
  type ConversationRewind,
} from "../../core/rewind/service";
import type { VesicleRequest } from "../../providers/shared/types";
import { fileCheckpointingEnabled } from "../../core/checkpoints/file-history";
import { applyComposerKey, normalizeKeyName } from "../composer";
import { rewindRestoreOptions } from "../RewindPicker";
import type { RewindPickerState, RewindRestoreOption } from "../types";
import type { CancellableOutcome } from "../turn-cancellation";

export type RewindKeyEvent = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  sequence?: string;
};

export type RewindControllerDependencies = {
  rootDir: string;
  sessionId: () => string | undefined;
  branchHead: () => { uuid: string | null } | null;
  busy: () => boolean;
  engine: () => EngineId;
  providerSelection: () => ProviderSelection;
  generation: () => VesicleRequest["generation"];
  setStatus: (status: string) => void;
  setBusy: (busy: boolean) => void;
  runCancellable: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<CancellableOutcome<T>>;
  refreshArtifacts: () => Promise<unknown>;
  applyConversation: (result: ConversationRewind) => Promise<void>;
};

export function createRewindController(deps: RewindControllerDependencies) {
  const [state, setState] = createSignal<RewindPickerState | null>(null);

  async function open(): Promise<void> {
    if (deps.busy()) {
      deps.setStatus("request in flight");
      return;
    }
    const id = deps.sessionId();
    const branch = deps.branchHead();
    try {
      const points = id
        ? await listRewindPoints(deps.rootDir, id, branch ? { headUuid: branch.uuid } : {})
        : [];
      setState({
        points,
        selected: points.length,
        restoreSelected: 0,
        summaryFeedback: "",
        summaryCursor: 0,
        busy: false,
      });
      deps.setStatus("rewind");
    } catch (error) {
      setState(emptyState(error instanceof Error ? error.message : String(error)));
    }
  }

  function reset(): void {
    setState(null);
  }

  function handleKey(key: RewindKeyEvent): boolean {
    const picker = state();
    if (!picker) return false;
    const name = normalizeKeyName(key.name);
    if (picker.busy) return true;
    if (picker.error) {
      if (name === "escape") reset();
      return true;
    }

    if (picker.target) {
      const options = rewindRestoreOptions(picker.target);
      if (name === "up" || name === "k" || (key.ctrl && name === "p")) {
        setState({ ...picker, restoreSelected: Math.max(0, picker.restoreSelected - 1) });
        return true;
      }
      if (name === "down" || name === "j" || (key.ctrl && name === "n")) {
        setState({ ...picker, restoreSelected: Math.min(options.length - 1, picker.restoreSelected + 1) });
        return true;
      }
      if (name === "escape") {
        setState({ ...picker, target: undefined, restoreSelected: 0, summaryFeedback: "", summaryCursor: 0 });
        return true;
      }
      if (name === "enter" || name === "return") {
        const option = options[picker.restoreSelected];
        if (option) void perform(option.value);
        return true;
      }
      if (options[picker.restoreSelected]?.value === "summarize") {
        const result = applyComposerKey({ value: picker.summaryFeedback, cursor: picker.summaryCursor }, key);
        if (result.handled) {
          setState({ ...picker, summaryFeedback: result.state.value, summaryCursor: result.state.cursor });
        }
      }
      return true;
    }

    const lastIndex = picker.points.length;
    if (name === "up" || name === "k" || (key.ctrl && name === "p")) {
      setState({ ...picker, selected: Math.max(0, picker.selected - 1) });
      return true;
    }
    if (name === "down" || name === "j" || (key.ctrl && name === "n")) {
      setState({ ...picker, selected: Math.min(lastIndex, picker.selected + 1) });
      return true;
    }
    if (((key.ctrl || key.shift || key.meta) && name === "up") || (key.shift && name === "k")) {
      setState({ ...picker, selected: 0 });
      return true;
    }
    if (((key.ctrl || key.shift || key.meta) && name === "down") || (key.shift && name === "j")) {
      setState({ ...picker, selected: lastIndex });
      return true;
    }
    if (name === "escape") {
      reset();
      deps.setStatus("ready");
      return true;
    }
    if (name === "enter" || name === "return") {
      const point = picker.points[picker.selected];
      if (!point) {
        reset();
        deps.setStatus("ready");
      } else if (!fileCheckpointingEnabled()) {
        void restoreConversationDirectly(point);
      } else {
        setState({ ...picker, target: point, restoreSelected: 0, summaryFeedback: "", summaryCursor: 0 });
      }
      return true;
    }
    return true;
  }

  async function perform(option: RewindRestoreOption): Promise<void> {
    const picker = state();
    const id = deps.sessionId();
    const point = picker?.target;
    if (!picker || !id || !point) return;
    if (option === "nevermind") {
      setState({ ...picker, target: undefined, restoreSelected: 0, summaryFeedback: "", summaryCursor: 0 });
      return;
    }
    setState({ ...picker, busy: true, restoringOption: option, error: undefined });
    try {
      if (option === "conversation") {
        await deps.applyConversation(await rewindConversation(deps.rootDir, id, point));
      } else if (option === "code") {
        const restored = await rewindCode(deps.rootDir, id, point);
        await deps.refreshArtifacts();
        deps.setStatus(`restored ${restored.length} file${restored.length === 1 ? "" : "s"}`);
      } else if (option === "both") {
        await deps.applyConversation(await rewindCodeAndConversation(deps.rootDir, id, point));
      } else {
        deps.setBusy(true);
        try {
          const outcome = await deps.runCancellable((signal) => summarizeConversationFrom({
            rootDir: deps.rootDir,
            sessionId: id,
            point,
            engine: deps.engine(),
            providerSelection: deps.providerSelection(),
            generation: deps.generation(),
            feedback: picker.summaryFeedback,
            signal,
          }));
          if (outcome.kind === "interrupted") throw new Error("Interrupted");
          await deps.applyConversation(outcome.value);
        } finally {
          deps.setBusy(false);
        }
      }
      reset();
    } catch (error) {
      setState({ ...picker, busy: false, restoringOption: undefined, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function restoreConversationDirectly(point: RewindPickerState["target"]): Promise<void> {
    const id = deps.sessionId();
    if (!id || !point) return;
    const picker = state();
    if (picker) setState({ ...picker, busy: true, restoringOption: "conversation" });
    try {
      await deps.applyConversation(await rewindConversation(deps.rootDir, id, point));
      reset();
    } catch (error) {
      setState(emptyState(error instanceof Error ? error.message : String(error)));
    }
  }

  return { state, open, reset, handleKey };
}

function emptyState(error: string): RewindPickerState {
  return {
    points: [],
    selected: 0,
    restoreSelected: 0,
    summaryFeedback: "",
    summaryCursor: 0,
    busy: false,
    error,
  };
}
