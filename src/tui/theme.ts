import { SyntaxStyle } from "@opentui/core";

/**
 * Shared syntax style for markdown and code rendering.
 *
 * This is intentionally not a full VSCode theme. It registers the token names
 * OpenTUI's bundled Markdown/inline Markdown and JS/TS/Zig tree-sitter queries
 * emit, plus shared base groups such as `keyword`, `string`, and `comment`.
 * JSON/YAML still need bundled parser/query assets before they can receive
 * semantic highlighting; until then they render with readable default text.
 *
 * The instance is created once per process and reused across renders. Prose
 * Colour tuning belongs here, not in individual message widgets, so the
 * transcript, artifact previews, and fenced code blocks stay visually aligned.
 */
export const sharedSyntaxStyle: SyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: "#dde1ea" },
  conceal: { fg: "#4a5470", dim: true },
  spell: { fg: "#dde1ea" },

  "markup.heading": { fg: "#10b981", bold: true },
  "markup.heading.1": { fg: "#10b981", bold: true },
  "markup.heading.2": { fg: "#22d3ee", bold: true },
  "markup.heading.3": { fg: "#e8c97a", bold: true },
  "markup.heading.4": { fg: "#aab2c5", bold: true },
  "markup.heading.5": { fg: "#aab2c5", bold: true },
  "markup.heading.6": { fg: "#aab2c5", bold: true },
  "markup.strong": { fg: "#e6d4a7", bold: true },
  "markup.italic": { fg: "#aab2c5", italic: true },
  "markup.strikethrough": { fg: "#6b7390", dim: true },
  "markup.raw": { fg: "#e8c97a" },
  "markup.raw.block": { fg: "#dde1ea" },
  "markup.link": { fg: "#67e8f9", underline: true },
  "markup.link.url": { fg: "#67e8f9", underline: true },
  "markup.link.label": { fg: "#67e8f9" },
  "markup.list": { fg: "#10b981", bold: true },
  "markup.list.checked": { fg: "#2dd4bf", bold: true },
  "markup.list.unchecked": { fg: "#6b7390" },
  "markup.quote": { fg: "#a89cd9", italic: true },
  label: { fg: "#a89cd9", bold: true },

  comment: { fg: "#6b7390", italic: true },
  string: { fg: "#2dd4bf" },
  "string.special": { fg: "#67e8f9" },
  "string.escape": { fg: "#e8c97a" },
  number: { fg: "#e8c97a" },
  boolean: { fg: "#e8c97a", bold: true },
  constant: { fg: "#e8c97a" },
  "constant.builtin": { fg: "#e8c97a", bold: true },
  character: { fg: "#2dd4bf" },
  "character.special": { fg: "#e8c97a" },

  variable: { fg: "#dde1ea" },
  "variable.builtin": { fg: "#67e8f9" },
  "variable.member": { fg: "#aab2c5" },
  property: { fg: "#aab2c5" },
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
  operator: { fg: "#aab2c5" },
  "punctuation.delimiter": { fg: "#6b7390" },
  "punctuation.bracket": { fg: "#aab2c5" },
  "punctuation.special": { fg: "#10b981" },
  tag: { fg: "#10b981", bold: true },
});

/**
 * Synaptic Prism — the Prism Vesicle TUI identity.
 *
 * Concept: a deep, cool "neural" surface (the vesicle) refracted by a single
 * emerald accent (the prism). Panels are separated by space and near-invisible
 * borders, reserving saturated colour for state (gates, errors) and for the
 * role spectrum that runs through the message stream. The goal is calm
 * density, not a generic blue chat shell.
 *
 * Palette roles:
 *   - Surfaces (bg / panelBorder / sectionBorder): dark, low-contrast; panels
 *     are defined by space, not loud lines.
 *   - Text hierarchy (textPrimary -> textDim): cool-neutral, receding.
 *   - Role spectrum (user / assistant / system / tool): cool incoming signal
 *     vs warm narrative vs muted mechanism — replaces the generic chat rainbow.
 *   - Semantic state (error / success / warn / gate*): desaturated signals.
 *   - brand: the one accent (emerald) — focus and identity.
 *   - lane*: dimmed role hues for the per-message left spectrum lane, the
 *     signature element; wired in the layout/component phase.
 *
 * This file is the single source of truth for colour. Swap values here to
 * re-theme the whole app without touching JSX — every surface reads palette.*.
 * Values are a first pass; tune live against the running TUI.
 */
export const palette = {
  // Surfaces — deep, cool, neural.
  bg: "#0b0e14",
  panelBorder: "#222a3a",
  sectionBorder: "#2b3346",

  // Text — cool-neutral hierarchy that recedes into the background.
  textPrimary: "#dde1ea",
  textSecondary: "#aab2c5",
  textMuted: "#6b7390",
  textDim: "#4a5470",

  // Role spectrum — cool incoming (user) vs warm narrative (assistant) vs
  // muted mechanism (system / tool).
  user: "#67e8f9",
  assistant: "#e6d4a7",
  system: "#a0acc0",
  tool: "#a89cd9",

  // Semantic state — desaturated so they read as signals, not decoration.
  error: "#ef4444",
  success: "#2dd4bf",
  warn: "#e8c97a",

  // Gates keep the one sanctioned loud family: amber (state-meaningful).
  gateBorder: "#d9923a",
  gateAccent: "#e8a94a",

  // Brand — the single accent. Emerald (replaces the earlier violet, which
  // read as generic AI-product chrome).
  brand: "#10b981",
  brandDim: "#1f9362", // dimmed emerald for structural labels / chrome accents

  // Signature: per-message left spectrum lane (dimmed role hues). Wired in the
  // layout/component phase; harmless here until consumed.
  laneUser: "#3d8fe0",
  laneAssistant: "#c2942f",
  laneSystem: "#798499",
  laneTool: "#6b5fa1",
} as const;

// Engine accents — the prism refracts into a hue per engine. etl inherits the
// emerald brand (default engine, unchanged look); the rest spread across the
// spectrum. Used for engine-scoped chrome (header, future turn markers). The
// per-message spectrum lane stays role-based and engine-independent.
const ENGINE_ACCENTS: Record<string, string> = {
  etl: "#10b981",
  runtime: "#22d3ee",
  evaluate: "#facc15",
  weaver: "#fb923c",
  "weaver-orch": "#f43f5e",
  dyad: "#e879f9",
  stage: "#e6d4a7",
};

export function engineAccent(engine: string): string {
  return ENGINE_ACCENTS[engine] ?? palette.brand;
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
