import type { EngineId } from "../core/engine/profile";

export type TerminalTitleMode = "auto" | "on" | "off";
export type TerminalTitleController = {
  set: (title: string) => void;
  setSession: (engine: EngineId | string, sessionTitle?: string) => void;
  clear: () => void;
  current: () => string | undefined;
  enabled: () => boolean;
};

export function sanitizeTerminalTitle(value: string, maxWidth = 120): string {
  const cleaned = value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let width = 0;
  let output = "";
  for (const char of Array.from(cleaned)) {
    const next = /[\u0000-\u00ff]/.test(char) ? 1 : 2;
    if (width + next > maxWidth) break;
    output += char;
    width += next;
  }
  return output;
}

export function oscTitleSequence(title: string): string {
  const safe = sanitizeTerminalTitle(title);
  return `\u001b]0;${safe}\u0007\u001b]2;${safe}\u0007`;
}

export function createTerminalTitleController(options: {
  stdout?: Pick<NodeJS.WriteStream, "isTTY" | "write">;
  env?: NodeJS.ProcessEnv;
} = {}): TerminalTitleController {
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const mode = (env.VESICLE_TERMINAL_TITLE ?? "auto") as TerminalTitleMode;
  const enabled = mode === "on" || (mode === "auto" && stdout.isTTY === true);
  let current: string | undefined;
  function set(title: string): void {
    if (!enabled) return;
    const safe = sanitizeTerminalTitle(title);
    if (!safe || safe === current) return;
    stdout.write(oscTitleSequence(safe));
    current = safe;
  }
  return {
    set,
    // A durable session title is already the user-facing identity. Prefixing it
    // wastes scarce tab width and can duplicate titles that mention Vesicle.
    setSession: (engine, sessionTitle) => set(sessionTitle || `Prism Vesicle · ${engine}`),
    clear: () => {
      if (!enabled || current === undefined) return;
      stdout.write(oscTitleSequence(""));
      current = undefined;
    },
    current: () => current,
    enabled: () => enabled,
  };
}
