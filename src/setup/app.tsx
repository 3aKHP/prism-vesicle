import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createSignal } from "solid-js";
import { applyComposerKey, insertComposerText, normalizeKeyName } from "../tui/composer";
import { runSetupEffect, type SetupEffectDependencies } from "./setup-effects";
import {
  createInitialSetupState,
  isSetupInputStep,
  setupIsBusy,
  transitionSetup,
  type SetupAction,
  type SetupCompletion,
  type SetupEffect,
  type SetupStep,
} from "./setup-state";
import { SetupView } from "./setup-views";

export type { SetupCompletion, SetupStep } from "./setup-state";
export {
  defaultProjectDirectory,
  resolveProjectPath,
  setupChoiceSupportsBack,
  setupMultiSelectBackAt,
  setupMultiSelectChoices,
  setupMultiSelectValueAt,
  setupReviewBackIndex,
} from "./setup-state";
export { maskValue, setupMultiSelectVisibleRowLimit, setupUsesCompactHeight } from "./setup-views";

export type SetupAppProps = SetupEffectDependencies & {
  initialStep?: SetupStep;
  onComplete: (result: SetupCompletion) => void;
};

export function SetupApp(props: SetupAppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const env = props.env ?? process.env;
  const [state, setState] = createSignal(createInitialSetupState(env, props.initialStep));

  useKeyboard((rawKey) => {
    const key = {
      name: normalizeKeyName(rawKey.name),
      ctrl: rawKey.ctrl,
      meta: rawKey.meta,
      shift: rawKey.shift,
      option: rawKey.option,
      sequence: rawKey.sequence,
      raw: rawKey.raw,
      preventDefault: () => rawKey.preventDefault(),
      stopPropagation: () => rawKey.stopPropagation(),
    };
    if (key.ctrl && (key.name === "q" || key.name === "c")) {
      complete({ launch: false });
      consumeKey(key);
      return;
    }
    if (setupIsBusy(state().step)) {
      consumeKey(key);
      return;
    }
    if (isSetupInputStep(state().step)) handleInputKey(key);
    else handleChoiceKey(key);
    consumeKey(key);
  });

  usePaste((event) => {
    if (!isSetupInputStep(state().step) || setupIsBusy(state().step)) {
      event.preventDefault();
      return;
    }
    const text = new TextDecoder().decode(event.bytes).replace(/[\r\n]+/g, " ");
    dispatch({ type: "set-input", input: insertComposerText(state().input, text) });
    event.preventDefault();
  });

  function handleInputKey(key: Parameters<typeof applyComposerKey>[1]): void {
    if (key.name === "escape") {
      dispatch({ type: "back" });
      return;
    }
    const result = applyComposerKey(state().input, key);
    dispatch({ type: "set-input", input: result.state });
    if (result.action?.type === "submit") dispatch({ type: "submit-input", value: result.action.value.trim() });
  }

  function handleChoiceKey(key: { name?: string; ctrl?: boolean }): void {
    if (key.name === "escape") {
      dispatch({ type: "back" });
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      dispatch({ type: "move-selection", delta: -1 });
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      dispatch({ type: "move-selection", delta: 1 });
      return;
    }
    const multi = state().step === "models" || state().step === "mcp-engines";
    if (state().step === "models" && key.name?.toLowerCase() === "a") {
      dispatch({ type: "add-model-input" });
      return;
    }
    if (multi && key.name === "space") {
      dispatch({ type: "toggle-multi" });
      return;
    }
    if (key.name !== "enter" && key.name !== "return") return;
    dispatch({ type: multi ? "continue-multi" : "choose" });
  }

  function dispatch(action: SetupAction): void {
    const transition = transitionSetup(state(), action, env);
    setState(transition.state);
    if (transition.completion) complete(transition.completion);
    if (transition.effect) void executeEffect(transition.effect);
  }

  async function executeEffect(effect: SetupEffect): Promise<void> {
    const result = await runSetupEffect(effect, {
      env,
      discoverModels: props.discoverModels,
      testMcp: props.testMcp,
      writeConfiguration: props.writeConfiguration,
    });
    dispatch({ type: "effect-result", result });
  }

  function complete(result: SetupCompletion): void {
    props.onComplete(result);
    process.nextTick(() => renderer.destroy());
  }

  return <SetupView state={state()} width={dimensions().width} height={dimensions().height} />;
}

function consumeKey(key: { preventDefault?: () => void; stopPropagation?: () => void }): void {
  key.preventDefault?.();
  key.stopPropagation?.();
}
