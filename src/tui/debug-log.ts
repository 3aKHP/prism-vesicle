import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getTreeSitterClient } from "@opentui/core";
import type { SimpleHighlight } from "@opentui/core";

let initialized = false;
let markdownDiagnosticsStarted = false;

export function debugLogEnabled(): boolean {
  const value = process.env.VESICLE_DEBUG_LOG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function initDebugLogging(): void {
  if (initialized || !debugLogEnabled()) return;
  initialized = true;
  debugLog("debug logging enabled", {
    platform: process.platform,
    execPath: process.execPath,
    cwd: process.cwd(),
    term: process.env.TERM,
    wtSession: process.env.WT_SESSION ? "present" : "absent",
    conEmu: process.env.ConEmuANSI,
    treeSitterWorkerPath: process.env.OTUI_TREE_SITTER_WORKER_PATH,
    treeSitterWorkerGlobal: (globalThis as typeof globalThis & { OTUI_TREE_SITTER_WORKER_PATH?: string }).OTUI_TREE_SITTER_WORKER_PATH,
  });
  process.on("uncaughtException", (error) => {
    debugLog("uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    debugLog("unhandledRejection", reason);
  });
  void logMarkdownDiagnostics();
}

export function debugLog(message: string, detail?: unknown): void {
  if (!debugLogEnabled()) return;
  try {
    const dir = join(process.cwd(), ".vesicle", "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "tui-debug.log"), `${new Date().toISOString()} ${message}${detail === undefined ? "" : ` ${formatDetail(detail)}`}\n`);
  } catch {
    // Debug logging must never affect the TUI.
  }
}

async function logMarkdownDiagnostics(): Promise<void> {
  if (markdownDiagnosticsStarted || !debugLogEnabled()) return;
  markdownDiagnosticsStarted = true;

  try {
    const client = getTreeSitterClient();
    client.on("error", (error, bufferId) => {
      debugLog("tree-sitter error", { error, bufferId });
    });
    client.on("warning", (warning, bufferId) => {
      debugLog("tree-sitter warning", { warning, bufferId });
    });
    client.on("worker:log", (logType, message) => {
      debugLog("tree-sitter worker log", { logType, message });
    });

    await logHighlightProbe("markdown", "**bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    await logHighlightProbe("typescript", "const value: number = 1;");
  } catch (error) {
    debugLog("markdown diagnostics failed", error);
  }
}

async function logHighlightProbe(filetype: string, content: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await getTreeSitterClient().highlightOnce(content, filetype);
    debugLog("tree-sitter highlight probe", {
      filetype,
      elapsedMs: Date.now() - startedAt,
      error: result.error,
      warning: result.warning,
      highlights: summarizeHighlights(result.highlights),
    });
  } catch (error) {
    debugLog("tree-sitter highlight probe threw", {
      filetype,
      elapsedMs: Date.now() - startedAt,
      error: formatDetail(error),
    });
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

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) return `${detail.stack ?? detail.name}: ${detail.message}`;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
