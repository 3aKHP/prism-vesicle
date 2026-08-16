import { createSignal } from "solid-js";
import { SyntaxStyle } from "@3akhp/opentui-core";
// Import for initialization ordering only: native-runtime pins the fork
// native library on module load, and sharedSyntaxStyle below is the first
// FFI touch in every channel, so this import must stay above it.
import "./native-runtime";

/**
 * Theme mode: the TUI ships a dark (night) and a light (day) palette derived
 * from the same locked brand palette. The preference domain has four values:
 *
 *   dark    — force the night palette.
 *   light   — force the day palette.
 *   default — follow the terminal's own reported light/dark mode, falling
 *             back to dark until a terminal reports. (This is the built-in.)
 *   auto    — local-time adaptation: light over [07:00, 19:00), dark otherwise.
 *
 * Effective source precedence (see project-preferences + theme controller):
 *   session /theme  >  CLI --dark/--light  >  project .vesicle/preferences.yaml
 *                  >  VESICLE_THEME env  >  built-in default
 *
 * The mode/preference/source signals live at module scope; every consumer
 * reads through the reactive `palette` getters, so a mode switch re-renders
 * the whole shell without touching call sites. `preference` and `source` are
 * signals so a scheduler owner (theme-runtime) can react to changes.
 */
export type ThemeMode = "dark" | "light";
export type ThemePreference = ThemeMode | "default" | "auto";
export type ThemePreferenceSource = "session" | "cli" | "project" | "env" | "builtin";

const [mode, setMode] = createSignal<ThemeMode>("dark");
const [preference, setPreference] = createSignal<ThemePreference>("default");
const [source, setSource] = createSignal<ThemePreferenceSource>("builtin");
let terminalMode: ThemeMode | null = null;

function applyPreference(): void {
  setMode(resolveThemeMode(preference(), terminalMode, new Date()));
}

/** Resolve a preference to a rendered palette mode. Pure: no clock but `now`. */
export function resolveThemeMode(
  preference: ThemePreference,
  terminal: ThemeMode | null,
  now: Date,
): ThemeMode {
  if (preference === "dark" || preference === "light") return preference;
  if (preference === "default") return terminal ?? "dark";
  return isLocalDaytime(now) ? "light" : "dark";
}

/** Local-time day window for `auto`: light over [07:00, 19:00), dark otherwise. */
export function isLocalDaytime(now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= 7 * 60 && minutes < 19 * 60;
}

/**
 * Next local 07:00 or 19:00 strictly after `now`. Constructed from local
 * calendar components so DST transitions remain coherent rather than adding a
 * fixed twelve-hour duration. Pure: no clock but `now`.
 */
export function nextAutoThemeBoundary(now: Date): Date {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const sevenToday = new Date(year, month, day, 7, 0, 0, 0);
  const nineteenToday = new Date(year, month, day, 19, 0, 0, 0);
  if (now < sevenToday) return sevenToday;
  if (now < nineteenToday) return nineteenToday;
  return new Date(year, month, day + 1, 7, 0, 0, 0);
}

/** Current resolved mode (never "default"/"auto"). */
export function themeMode(): ThemeMode {
  return mode();
}

/** Current effective preference as requested by the active source. */
export function themePreference(): ThemePreference {
  return preference();
}

/** Current effective source: the highest-priority input that supplied the preference. */
export function themeSource(): ThemePreferenceSource {
  return source();
}

/**
 * Set the effective preference and its source, then re-resolve. The caller
 * picks the source so the controller (not this module) owns precedence.
 */
export function setThemePreference(next: ThemePreference, src: ThemePreferenceSource = "session"): void {
  setPreference(next);
  setSource(src);
  applyPreference();
}

/**
 * Re-resolve from the actual current time. The auto-boundary scheduler calls
 * this from its timer callback so a delayed fire (e.g. after sleep) self-corrects.
 */
export function refreshAutoTheme(): void {
  applyPreference();
}

/**
 * Feed a terminal-reported mode (startup detection / theme_mode event). The
 * cache always updates; a rendered mode change happens only while the effective
 * preference is `default` (terminal following). Pass null to clear the report.
 */
export function reportTerminalThemeMode(next: ThemeMode | null): void {
  terminalMode = next;
  if (preference() === "default") applyPreference();
}

/**
 * Shared syntax style for markdown and code rendering.
 *
 * This is intentionally not a full VSCode theme. It registers the token names
 * OpenTUI's bundled Markdown/inline Markdown and JS/TS/Zig tree-sitter queries
 * emit, plus shared base groups such as `keyword`, `string`, and `comment`.
 * JSON/YAML still need bundled parser/query assets before they can receive
 * semantic highlighting; until then they render with readable default text.
 *
 * One instance per theme mode. The dark instance stays exported as
 * `sharedSyntaxStyle` (stable default for tests and non-reactive callers);
 * interactive markdown goes through `syntaxStyle()`, which follows the mode.
 */
export const sharedSyntaxStyle: SyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: "#e3e5e6" },
  conceal: { fg: "#54585b", dim: true },
  spell: { fg: "#e3e5e6" },

  "markup.heading": { fg: "#10b981", bold: true },
  "markup.heading.1": { fg: "#10b981", bold: true },
  "markup.heading.2": { fg: "#22d3ee", bold: true },
  "markup.heading.3": { fg: "#e8c97a", bold: true },
  "markup.heading.4": { fg: "#aeb2b4", bold: true },
  "markup.heading.5": { fg: "#aeb2b4", bold: true },
  "markup.heading.6": { fg: "#aeb2b4", bold: true },
  "markup.strong": { fg: "#e6d4a7", bold: true },
  "markup.italic": { fg: "#aeb2b4", italic: true },
  "markup.strikethrough": { fg: "#787c7f", dim: true },
  "markup.raw": { fg: "#e8c97a" },
  "markup.raw.block": { fg: "#e3e5e6" },
  "markup.link": { fg: "#67e8f9", underline: true },
  "markup.link.url": { fg: "#67e8f9", underline: true },
  "markup.link.label": { fg: "#67e8f9" },
  "markup.list": { fg: "#10b981", bold: true },
  "markup.list.checked": { fg: "#2dd4bf", bold: true },
  "markup.list.unchecked": { fg: "#787c7f" },
  "markup.quote": { fg: "#a89cd9", italic: true },
  label: { fg: "#a89cd9", bold: true },

  comment: { fg: "#787c7f", italic: true },
  string: { fg: "#2dd4bf" },
  "string.special": { fg: "#67e8f9" },
  "string.escape": { fg: "#e8c97a" },
  number: { fg: "#e8c97a" },
  boolean: { fg: "#e8c97a", bold: true },
  constant: { fg: "#e8c97a" },
  "constant.builtin": { fg: "#e8c97a", bold: true },
  character: { fg: "#2dd4bf" },
  "character.special": { fg: "#e8c97a" },

  variable: { fg: "#e3e5e6" },
  "variable.builtin": { fg: "#67e8f9" },
  "variable.member": { fg: "#aeb2b4" },
  property: { fg: "#aeb2b4" },
  function: { fg: "#22d3ee", bold: true },
  "function.call": { fg: "#22d3ee" },
  "function.method": { fg: "#22d3ee" },
  "function.method.call": { fg: "#22d3ee" },
  "function.builtin": { fg: "#67e8f9", bold: true },
  constructor: { fg: "#facc15", bold: true },
  type: { fg: "#a89cd9" },
  "type.builtin": { fg: "#a89cd9", bold: true },
  attribute: { fg: "#e879f9" },
  module: { fg: "#a89cd9" },
  "module.builtin": { fg: "#a89cd9", bold: true },

  keyword: { fg: "#e879f9", bold: true },
  "keyword.directive": { fg: "#f43f5e", bold: true },
  operator: { fg: "#aeb2b4" },
  "punctuation.delimiter": { fg: "#787c7f" },
  "punctuation.bracket": { fg: "#aeb2b4" },
  "punctuation.special": { fg: "#10b981" },
  tag: { fg: "#10b981", bold: true },
});

/**
 * Day variant: same token hues, deepened and softened (chroma × 0.8) so
 * prose and code stay legible and calm on the light ground (text-class
 * tokens ≥ 4.5:1 on #f5f4f0).
 */
const lightSyntaxStyle: SyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: "#23261f" },
  conceal: { fg: "#9b9d91", dim: true },
  spell: { fg: "#23261f" },

  "markup.heading": { fg: "#266f54", bold: true },
  "markup.heading.1": { fg: "#266f54", bold: true },
  "markup.heading.2": { fg: "#296c82", bold: true },
  "markup.heading.3": { fg: "#a25628", bold: true },
  "markup.heading.4": { fg: "#4b4e45", bold: true },
  "markup.heading.5": { fg: "#4b4e45", bold: true },
  "markup.heading.6": { fg: "#4b4e45", bold: true },
  "markup.strong": { fg: "#6d624b", bold: true },
  "markup.italic": { fg: "#4b4e45", italic: true },
  "markup.strikethrough": { fg: "#6b6e64", dim: true },
  "markup.raw": { fg: "#a25628" },
  "markup.raw.block": { fg: "#23261f" },
  "markup.link": { fg: "#296c82", underline: true },
  "markup.link.url": { fg: "#296c82", underline: true },
  "markup.link.label": { fg: "#296c82" },
  "markup.list": { fg: "#266f54", bold: true },
  "markup.list.checked": { fg: "#23624c", bold: true },
  "markup.list.unchecked": { fg: "#6b6e64" },
  "markup.quote": { fg: "#623192", italic: true },
  label: { fg: "#623192", bold: true },

  comment: { fg: "#6b6e64", italic: true },
  string: { fg: "#296d67" },
  "string.special": { fg: "#296c82" },
  "string.escape": { fg: "#a25628" },
  number: { fg: "#a25628" },
  boolean: { fg: "#a25628", bold: true },
  constant: { fg: "#a25628" },
  "constant.builtin": { fg: "#a25628", bold: true },
  character: { fg: "#296d67" },
  "character.special": { fg: "#a25628" },

  variable: { fg: "#23261f" },
  "variable.builtin": { fg: "#296c82" },
  "variable.member": { fg: "#4b4e45" },
  property: { fg: "#4b4e45" },
  function: { fg: "#296c82", bold: true },
  "function.call": { fg: "#296c82" },
  "function.method": { fg: "#296c82" },
  "function.method.call": { fg: "#296c82" },
  "function.builtin": { fg: "#296c82", bold: true },
  constructor: { fg: "#926128", bold: true },
  type: { fg: "#623192" },
  "type.builtin": { fg: "#623192", bold: true },
  attribute: { fg: "#91329b" },
  module: { fg: "#623192" },
  "module.builtin": { fg: "#623192", bold: true },

  keyword: { fg: "#91329b", bold: true },
  "keyword.directive": { fg: "#a92e40", bold: true },
  operator: { fg: "#4b4e45" },
  "punctuation.delimiter": { fg: "#6b6e64" },
  "punctuation.bracket": { fg: "#4b4e45" },
  "punctuation.special": { fg: "#266f54" },
  tag: { fg: "#266f54", bold: true },
});

/** Mode-following syntax style for interactive markdown surfaces. */
export function syntaxStyle(): SyntaxStyle {
  return mode() === "light" ? lightSyntaxStyle : sharedSyntaxStyle;
}

/**
 * Synaptic Prism — the Prism Vesicle TUI identity.
 *
 * Concept: a calm surface refracted by a single emerald accent (the prism).
 * Panels are separated by space and near-invisible borders, reserving
 * saturated colour for state (gates, errors) and for the role spectrum that
 * runs through the message stream. The goal is calm density, not a generic
 * blue chat shell. Two modes share one structure:
 *   - dark: neutral graphite ground (hue ≈ 200°, chroma ≤ 8% — no warm cast,
 *     which reads dirty at terminal scale; no SaaS blue);
 *   - light: locked warm off-white #f5f4f0 (never pure white — emerald reads
 *     cheap on white), text and accents deepened and softened (chroma × 0.8)
 *     so saturated roles sit calmly on paper.
 *
 * Palette roles:
 *   - Surfaces (bg / panelBorder / sectionBorder): low-contrast; panels are
 *     defined by space, not loud lines.
 *   - Text hierarchy (textPrimary -> textDim): neutral, receding.
 *   - Role spectrum (user / assistant / system / tool): cool incoming signal
 *     vs warm narrative vs muted mechanism — replaces the generic chat rainbow.
 *   - Semantic state (error / success / warn / gate*): desaturated signals.
 *   - brand: the one accent (emerald) — focus and identity.
 *   - lane*: dimmed role hues for the per-message left spectrum lane, the
 *     signature element; consumed by the message widgets (user / assistant /
 *     system / tool lanes).
 *
 * This file is the single source of truth for colour. Swap values here to
 * re-theme the whole app without touching JSX — every surface reads palette.*.
 */
export type ThemePalette = {
  bg: string;
  panelBorder: string;
  sectionBorder: string;
  selectionForeground: string;
  selectionBackground: string;
  editorCursor: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;
  user: string;
  assistant: string;
  system: string;
  tool: string;
  error: string;
  success: string;
  warn: string;
  gateBorder: string;
  gateAccent: string;
  brand: string;
  brandDim: string;
  laneUser: string;
  laneAssistant: string;
  laneSystem: string;
  laneTool: string;
};

const DARK_PALETTE: ThemePalette = {
  bg: "#121415",
  panelBorder: "#272b2d",
  sectionBorder: "#32373a",
  selectionForeground: "#121415",
  selectionBackground: "#e3e5e6",
  editorCursor: "#10b981",

  textPrimary: "#e3e5e6",
  textSecondary: "#aeb2b4",
  textMuted: "#787c7f",
  textDim: "#54585b",

  // Role spectrum — cool incoming (user) vs warm paper narrative (assistant)
  // vs muted mechanism (system / tool). Assistant is deliberately desaturated
  // paper, not gold: engine identity rides the `▣ Engine` label anyway.
  user: "#67e8f9",
  assistant: "#ded7c8",
  system: "#aaaeb1",
  tool: "#a89cd9",

  // Semantic state — success is locked emerald-bright ("the brand works");
  // error is deep alarm red, kept darker than weaver-orch's rose so
  // alert ≠ engine identity.
  error: "#dc2626",
  success: "#34d399",
  warn: "#d97706",

  // Gates keep the one sanctioned loud family: amber (state-meaningful).
  // warn shares the locked amber — attention semantics are one family.
  gateBorder: "#d97706",
  gateAccent: "#e8a94a",

  brand: "#10b981",
  brandDim: "#1f9362",

  // Signature: per-message left spectrum lane (dimmed role hues).
  laneUser: "#2b8fa3",
  laneAssistant: "#9a917c",
  laneSystem: "#7e8285",
  laneTool: "#6b5fa1",
};

const LIGHT_PALETTE: ThemePalette = {
  // Locked warm off-white ground; never pure white (brand rule).
  bg: "#f5f4f0",
  panelBorder: "#d9d6cb",
  sectionBorder: "#c6c3b7",
  selectionForeground: "#f5f4f0",
  selectionBackground: "#23261f",
  editorCursor: "#266f54",

  textPrimary: "#23261f",
  textSecondary: "#4b4e45",
  textMuted: "#6b6e64",
  textDim: "#9b9d91",

  // Same role hues, deepened and softened (lower chroma) for the light
  // ground — full-strength accents read harsh on paper. user sits darker
  // than runtime's cyan here (the dark mode lightness split inverted).
  user: "#245769",
  assistant: "#6d624b",
  system: "#5f635a",
  tool: "#623192",

  error: "#a4312a",
  success: "#266f54",
  warn: "#a25628",

  // On the light ground the roles swap: the locked amber carries the border
  // (decorative), the softened deep amber carries accent text (≥ 4.5:1).
  gateBorder: "#d97706",
  gateAccent: "#a25628",

  // Softened derivative of the locked deep emerald day anchor.
  brand: "#266f54",
  brandDim: "#23624c",

  laneUser: "#6ea0aa",
  laneAssistant: "#9f947e",
  laneSystem: "#959991",
  laneTool: "#9c90b6",
};

/** Static per-mode palette lookup (non-reactive; tests and one-shot reads). */
export function paletteFor(mode: ThemeMode): ThemePalette {
  return mode === "light" ? LIGHT_PALETTE : DARK_PALETTE;
}

/**
 * Reactive palette: getters following the mode signal. Reads inside render
 * are tracked by Solid, so a mode switch re-renders the shell with no call
 * site changes.
 */
export const palette: ThemePalette = (() => {
  const reactive = {} as Record<string, string>;
  for (const key of Object.keys(DARK_PALETTE) as (keyof ThemePalette)[]) {
    Object.defineProperty(reactive, key, {
      enumerable: true,
      get: () => paletteFor(mode())[key],
    });
  }
  return reactive as ThemePalette;
})();

// Engine accents — the prism refracts into a hue per engine. etl inherits the
// emerald brand (default engine, unchanged look); the five refraction hues are
// the locked engine spectrum. stage took the locked palette's last unused
// hue, violet (the earlier warm gold sat only 5° from evaluate's yellow).
const DARK_ENGINE_ACCENTS: Record<string, string> = {
  etl: "#10b981",
  runtime: "#22d3ee",
  evaluate: "#facc15",
  weaver: "#fb923c",
  "weaver-orch": "#f43f5e",
  dyad: "#e879f9",
  stage: "#8b5cf6",
};

// The light table is the same hues deepened one step and softened (chroma
// × 0.8) so they sit calmly on paper; etl and stage stay anchored on the
// locked deep emerald and the locked violet.
const LIGHT_ENGINE_ACCENTS: Record<string, string> = {
  etl: "#266f54",
  runtime: "#296c82",
  evaluate: "#7e5f22",
  weaver: "#ae4a29",
  "weaver-orch": "#a92e40",
  dyad: "#91329b",
  stage: "#7247ce",
};

export function engineAccent(engine: string): string {
  const accents = mode() === "light" ? LIGHT_ENGINE_ACCENTS : DARK_ENGINE_ACCENTS;
  return accents[engine] ?? palette.brand;
}

// Short, capitalised display names for engine ids (etl → ETL; abbreviations
// uppercased, words title-cased). Mirrors the short form of each profile's
// displayName. The id stays the storage/command form; this is display-only.
const ENGINE_DISPLAY_NAMES: Record<string, string> = {
  etl: "ETL",
  runtime: "Runtime",
  evaluate: "Evaluate",
  weaver: "Weaver",
  "weaver-orch": "Weaver-Orch",
  dyad: "Dyad",
  stage: "Stage",
};

/** Capitalised short label for an engine id; falls back to the id itself. */
export function engineDisplayName(engine: string): string {
  return ENGINE_DISPLAY_NAMES[engine] ?? engine;
}
