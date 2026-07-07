import { SyntaxStyle } from "@opentui/core";

/**
 * Shared syntax style for markdown and code rendering.
 *
 * M0 does not ship a full VSCode-style theme; this style registers the
 * minimum token names the markdown renderer consults so that prose renders
 * with readable defaults and fenced code blocks fall back to plain text
 * (JSON/YAML highlighting would need bundled tree-sitter parsers, which is
 * intentionally deferred).
 *
 * The instance is created once per process and reused across renders.
 */
export const sharedSyntaxStyle: SyntaxStyle = SyntaxStyle.create();

/**
 * Centralised colour palette. Kept in one place so a future theme pass can
 * change the look without grepping hex codes out of JSX.
 */
export const palette = {
  // Surfaces
  bg: "#101214",
  panelBorder: "#3b82f6",
  sectionBorder: "#475569",

  // Text
  textPrimary: "#e2e8f0",
  textSecondary: "#cbd5e1",
  textMuted: "#94a3b8",
  textDim: "#64748b",

  // Semantic
  user: "#93c5fd",
  assistant: "#86efac",
  system: "#fcd34d",
  tool: "#c4b5fd",
  error: "#fca5a5",
  success: "#86efac",
  warn: "#fde68a",
  gateBorder: "#f59e0b",
  gateAccent: "#fbbf24",

  // Brand
  brand: "#dbeafe",
} as const;
