import {
  nextAutoThemeBoundary,
  setThemePreference,
  themeMode,
  type ThemePreference,
  type ThemePreferenceSource,
} from "./theme";
import {
  readProjectThemePreference,
  unsetProjectThemePreference,
  writeProjectThemePreference,
} from "../config/project-preferences";

/**
 * Effective source resolution and session-override/project-persistence owner
 * for the four-value theme preference (plan §6, §8.4, §8.5).
 *
 * Precedence (highest first):
 *   session /theme  >  CLI --dark/--light  >  project .vesicle/preferences.yaml
 *                  >  VESICLE_THEME env  >  built-in default
 *
 * The controller is constructed once per process with the startup inputs
 * already resolved (caller chooses whether to read a project preference —
 * Guided Setup does not). It applies the effective preference before the first
 * themed frame, tracks the session override, persists/unsets the project
 * preference, and recomputes when the override is cleared by /new or resume.
 *
 * `theme.ts` stays the reactive palette authority; this module owns policy.
 */

export type EnvThemeParse = { value?: ThemePreference; valid: boolean; present: boolean; raw?: string };

export type ThemePreferenceControllerInputs = {
  /** Effective project root, used for persist/unset I/O. */
  rootDir: string;
  /** CLI `--dark`/`--light` process-scoped preference, if supplied. */
  cliPreference?: "dark" | "light";
  /** Parsed VESICLE_THEME value. */
  envParse: EnvThemeParse;
  /** Resolved project preference. Omit for surfaces with no selected project (Guided Setup). */
  project?: { theme?: ThemePreference; diagnostic?: string };
};

export type ThemePreferenceController = {
  /** Apply the effective startup preference (no session override). */
  applyStartup: () => void;
  /** Set a session-only override (`/theme <pref>`). */
  applyOverride: (pref: ThemePreference) => void;
  /** Clear the session override and re-apply startup (`/new`, resume). */
  clearOverride: () => void;
  /** Persist the project preference and apply it as the session override (`/theme <pref> --persist`). */
  persistProject: (pref: ThemePreference) => Promise<void>;
  /** Remove the project preference, clear the override, recompute (`/theme --unset-project`). */
  unsetProject: () => Promise<void>;
  /** Current effective preference + source (session override wins). */
  effective: () => { preference: ThemePreference; source: ThemePreferenceSource };
  /** Human-readable status block for `/theme`. */
  statusText: () => string;
  /** Bounded startup diagnostics (invalid env / invalid project file). */
  startupDiagnostics: () => string[];
};

/** Parse a raw VESICLE_THEME value into one of the four preferences (or invalid). */
export function parseEnvTheme(raw: string | undefined): EnvThemeParse {
  if (raw === undefined) return { valid: true, present: false };
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return { valid: true, present: false, raw };
  if (trimmed === "dark" || trimmed === "light" || trimmed === "default" || trimmed === "auto") {
    return { value: trimmed, valid: true, present: true, raw };
  }
  return { valid: false, present: true, raw };
}

/**
 * Pure source selection from the non-session inputs. The built-in preference
 * is `default` (terminal-following), not `auto`.
 */
export function selectStartupPreference(input: {
  cli?: "dark" | "light";
  project?: ThemePreference;
  env?: ThemePreference;
}): { preference: ThemePreference; source: ThemePreferenceSource } {
  if (input.cli === "dark" || input.cli === "light") return { preference: input.cli, source: "cli" };
  if (input.project) return { preference: input.project, source: "project" };
  if (input.env) return { preference: input.env, source: "env" };
  return { preference: "default", source: "builtin" };
}

export function createThemePreferenceController(inputs: ThemePreferenceControllerInputs): ThemePreferenceController {
  const { rootDir, cliPreference, envParse, project } = inputs;
  const diagnostics: string[] = [];
  if (envParse.present && !envParse.valid) {
    diagnostics.push(`VESICLE_THEME=${quoteRaw(envParse.raw)} is not a valid theme (expected dark, light, default, or auto); using the built-in default.`);
  }
  if (project?.diagnostic) diagnostics.push(project.diagnostic);

  let projectPreference = project?.theme;
  let startup = selectStartupPreference({ cli: cliPreference, project: projectPreference, env: envParse.value });
  let sessionOverride: ThemePreference | null = null;

  function effective(): { preference: ThemePreference; source: ThemePreferenceSource } {
    return sessionOverride !== null ? { preference: sessionOverride, source: "session" } : startup;
  }

  function reapply(): void {
    const { preference, source } = effective();
    setThemePreference(preference, source);
  }

  return {
    applyStartup: reapply,
    applyOverride(pref) {
      sessionOverride = pref;
      reapply();
    },
    clearOverride() {
      sessionOverride = null;
      reapply();
    },
    async persistProject(pref) {
      await writeProjectThemePreference(rootDir, pref);
      projectPreference = pref;
      startup = selectStartupPreference({ cli: cliPreference, project: projectPreference, env: envParse.value });
      sessionOverride = pref;
      reapply();
    },
    async unsetProject() {
      await unsetProjectThemePreference(rootDir);
      projectPreference = undefined;
      startup = selectStartupPreference({ cli: cliPreference, project: undefined, env: envParse.value });
      sessionOverride = null;
      reapply();
    },
    effective,
    statusText() {
      return formatThemeStatus(effective(), rootDir);
    },
    startupDiagnostics() {
      return diagnostics;
    },
  };
}

/** Re-export so callers (runTui/setup) can read the project preference without a second import site. */
export { readProjectThemePreference };

function formatThemeStatus(state: { preference: ThemePreference; source: ThemePreferenceSource }, _rootDir: string): string {
  const { preference, source } = state;
  const lines = [
    "Theme",
    `preference: ${preference}`,
    `source: ${source}`,
    `resolved: ${themeMode()}`,
  ];
  if (preference === "default") {
    lines.push("default follows the terminal's own light/dark mode (dark until a terminal reports).");
  } else if (preference === "auto") {
    const next = nextAutoThemeBoundary(new Date());
    lines.push(`auto follows the clock: light 07:00–19:00 local, dark otherwise. Next boundary: ${formatBoundary(next)}.`);
  }
  lines.push("Use /theme dark|light|default|auto [--persist] [--unset-project].");
  return lines.join("\n");
}

function formatBoundary(next: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(next.getHours())}:${pad(next.getMinutes())}`;
}

function quoteRaw(raw: string | undefined): string {
  return raw === undefined ? "" : `"${raw.trim()}"`;
}
