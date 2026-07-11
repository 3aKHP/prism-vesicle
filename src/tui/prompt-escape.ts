import { DoublePressTracker } from "./double-press";

export type PromptEscapeAction =
  | "interrupt"
  | "arm-clear"
  | "clear"
  | "arm-rewind"
  | "rewind"
  | "noop";

export class PromptEscapeController {
  private readonly empty = new DoublePressTracker();
  private readonly draft = new DoublePressTracker();

  press(state: { busy: boolean; draft: string; hasSession: boolean }, now = Date.now()): PromptEscapeAction {
    if (state.busy) return "interrupt";
    if (state.draft.length > 0) {
      this.empty.reset();
      return this.draft.press(now) === "double" ? "clear" : "arm-clear";
    }
    this.draft.reset();
    if (!state.hasSession) return "noop";
    return this.empty.press(now) === "double" ? "rewind" : "arm-rewind";
  }
}
