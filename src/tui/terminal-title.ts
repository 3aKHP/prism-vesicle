import type { EngineId } from "../core/engine/profile";
import { displayWidth, segmentGraphemes } from "./format";

export type TerminalTitleMode = "auto" | "on" | "off";
export type TerminalTitlePhase = "idle" | "working" | "input-required";

export function resolveTerminalTitlePhase(input: {
  inputRequired: boolean;
  busy: boolean;
  restoring: boolean;
}): TerminalTitlePhase {
  if (input.inputRequired) return "input-required";
  if (input.busy || input.restoring) return "working";
  return "idle";
}

export type TerminalTitleWriter = {
  setTerminalTitle: (title: string) => void;
};

type TimerHandle = ReturnType<typeof setInterval>;
type TimerApi = {
  setInterval: (handler: () => void, timeout: number) => TimerHandle;
  clearInterval: (handle: TimerHandle) => void;
};

export type TerminalTitleController = {
  attach: (writer: TerminalTitleWriter) => void;
  set: (title: string) => void;
  setSetup: () => void;
  setSession: (engine: EngineId | string, sessionTitle?: string, projectBasename?: string) => void;
  setPhase: (phase: TerminalTitlePhase) => void;
  reproject: () => void;
  clear: () => void;
  current: () => string | undefined;
  enabled: () => boolean;
};

const WORKING_FRAMES = ["‹", "◇", "›", "◇"] as const;
export const TERMINAL_TITLE_FRAME_INTERVAL_MS = 800;
const DEFAULT_MAX_WIDTH = 120;

/**
 * Remove terminal-control and Unicode formatting characters, collapse the
 * remaining value to one line, and cap it by terminal display width.
 */
export function sanitizeTerminalTitle(value: string, maxWidth = DEFAULT_MAX_WIDTH): string {
  const cleaned = value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/[\r\n\v\f\t]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (maxWidth <= 0) return "";

  let width = 0;
  let output = "";
  for (const grapheme of segmentGraphemes(cleaned)) {
    const nextWidth = displayWidth(grapheme);
    if (width + nextWidth > maxWidth) break;
    output += grapheme;
    width += nextWidth;
  }
  return output;
}

export function createTerminalTitleController(options: {
  writer?: TerminalTitleWriter;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  timers?: TimerApi;
} = {}): TerminalTitleController {
  let writer = options.writer;
  const env = options.env ?? process.env;
  const mode = parseMode(env.VESICLE_TERMINAL_TITLE);
  const disabled = env.VESICLE_DISABLE_TERMINAL_TITLE === "1";
  const enabled = !disabled && (mode === "on" || (mode === "auto" && (options.isTTY ?? process.stdout.isTTY === true)));
  const reducedMotion = env.VESICLE_REDUCED_MOTION === "1";
  const timers = options.timers ?? {
    setInterval: (handler, timeout) => setInterval(handler, timeout),
    clearInterval: (handle) => clearInterval(handle),
  };

  let baseTitle: string | undefined;
  let setupTitle = false;
  let phase: TerminalTitlePhase = "idle";
  let frameIndex = 0;
  let animation: TimerHandle | undefined;
  let currentTitle: string | undefined;
  let disposed = false;

  function attach(nextWriter: TerminalTitleWriter): void {
    if (disposed) return;
    if (writer === nextWriter) return;
    stopAnimation();
    writer = nextWriter;
    currentTitle = undefined;
    ensureAnimation();
    render(true);
  }

  function stopAnimation(): void {
    if (animation === undefined) return;
    timers.clearInterval(animation);
    animation = undefined;
  }

  function ensureAnimation(): void {
    if (!enabled || reducedMotion || setupTitle || phase !== "working" || animation !== undefined) return;
    animation = timers.setInterval(() => {
      frameIndex = (frameIndex + 1) % WORKING_FRAMES.length;
      render(true);
    }, TERMINAL_TITLE_FRAME_INTERVAL_MS);
  }

  function composedTitle(): string | undefined {
    if (setupTitle) return "Prism Vesicle Setup";
    if (!baseTitle) return undefined;
    const marker = phase === "idle" ? "·" : phase === "input-required" ? "!" : reducedMotion ? "◇" : WORKING_FRAMES[frameIndex];
    return sanitizeTerminalTitle(`${marker} ${baseTitle}`);
  }

  function render(force: boolean): void {
    if (disposed || !enabled || !writer) return;
    const title = composedTitle();
    if (!title || (!force && title === currentTitle)) return;
    writer.setTerminalTitle(title);
    currentTitle = title;
  }

  function set(title: string): void {
    if (disposed) return;
    setupTitle = false;
    baseTitle = sanitizeTerminalTitle(title);
    render(false);
  }

  function setSetup(): void {
    if (disposed) return;
    stopAnimation();
    setupTitle = true;
    baseTitle = undefined;
    phase = "idle";
    frameIndex = 0;
    render(false);
  }

  function setSession(engine: EngineId | string, sessionTitle?: string, projectBasename?: string): void {
    if (disposed) return;
    setupTitle = false;
    const title = sanitizeTerminalTitle(sessionTitle ?? "");
    if (title) {
      baseTitle = title;
    } else {
      const project = safeProjectBasename(projectBasename);
      const fallback = project || sanitizeTerminalTitle(String(engine)) || "project";
      baseTitle = `Prism Vesicle · ${fallback}`;
    }
    ensureAnimation();
    render(false);
  }

  function setPhase(nextPhase: TerminalTitlePhase): void {
    if (disposed) return;
    const changed = nextPhase !== phase;
    phase = nextPhase;
    if (changed) frameIndex = 0;
    if (phase === "working") ensureAnimation();
    else stopAnimation();
    render(changed);
  }

  function reproject(): void {
    if (disposed) return;
    ensureAnimation();
    render(true);
  }

  function clear(): void {
    if (disposed) return;
    disposed = true;
    stopAnimation();
    if (enabled && writer && currentTitle !== undefined) writer.setTerminalTitle("");
    currentTitle = undefined;
    baseTitle = undefined;
    setupTitle = false;
  }

  return {
    attach,
    set,
    setSetup,
    setSession,
    setPhase,
    reproject,
    clear,
    current: () => currentTitle,
    enabled: () => enabled,
  };
}

function parseMode(value: string | undefined): TerminalTitleMode {
  if (value === undefined) return "auto";
  return value === "on" || value === "off" || value === "auto" ? value : "off";
}

function safeProjectBasename(value: string | undefined): string {
  const segment = value?.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return sanitizeTerminalTitle(segment);
}
