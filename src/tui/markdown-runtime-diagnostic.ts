import { destroyTreeSitterClient, getTreeSitterClient } from "@opentui/core";
import type { SimpleHighlight } from "@opentui/core";

declare const VESICLE_TREE_SITTER_WORKER_PATH: string;

type RuntimeProbe = {
  filetype: "markdown" | "typescript";
  error?: string;
  warning?: string;
  highlights: { count: number; groups: string[] };
};

export type MarkdownRuntimeDiagnostic = {
  ok: boolean;
  workerPath?: string;
  probes: RuntimeProbe[];
};

/**
 * Verify the worker, web-tree-sitter runtime, bundled grammars, and fixed
 * highlight inputs without starting the interactive TUI or reading user data.
 */
export async function runMarkdownRuntimeDiagnostic(): Promise<MarkdownRuntimeDiagnostic> {
  try {
    const probes = await Promise.all([
      probe("markdown", "**bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |"),
      probe("typescript", "const value: number = 1;"),
    ]);
    return {
      ok: probes.every((entry) => !entry.error && entry.highlights.count > 0),
      workerPath: typeof VESICLE_TREE_SITTER_WORKER_PATH !== "undefined"
        ? VESICLE_TREE_SITTER_WORKER_PATH
        : process.env.OTUI_TREE_SITTER_WORKER_PATH,
      probes,
    };
  } finally {
    // The diagnostic is a short-lived CLI operation. Leaving OpenTUI's worker
    // alive keeps Bun's event loop open and makes CI smoke commands hang.
    await destroyTreeSitterClient().catch(() => undefined);
  }
}

async function probe(filetype: RuntimeProbe["filetype"], content: string): Promise<RuntimeProbe> {
  try {
    const result = await getTreeSitterClient().highlightOnce(content, filetype);
    return {
      filetype,
      error: result.error,
      warning: result.warning,
      highlights: summarizeHighlights(result.highlights),
    };
  } catch (error) {
    return {
      filetype,
      error: error instanceof Error ? error.message : String(error),
      highlights: { count: 0, groups: [] },
    };
  }
}

function summarizeHighlights(highlights: SimpleHighlight[] | undefined): { count: number; groups: string[] } {
  const groups = new Set<string>();
  for (const highlight of highlights ?? []) {
    if (groups.size >= 8) break;
    groups.add(highlight[2]);
  }
  return { count: highlights?.length ?? 0, groups: Array.from(groups) };
}
