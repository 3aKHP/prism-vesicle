/**
 * Pure rendering model for inline tool cards (Phase D). No JSX, no reactive
 * state — the {@link ToolCard} widget consumes these functions. Keeping the
 * logic here means the diff/fold/footer behaviour is unit-testable without a
 * terminal.
 *
 * Data sources (see agent-loop `AgentLoopEvent`):
 *   - tool_call event  → { name, arguments }   (arguments = complete JSON)
 *   - tool_result event → { name, ok, content, fileEvent?, webEvent?, mcpEvent? }
 *
 * The two events are linked by callId and arrive consecutively, so the call
 * renders the `●` header + content body and the result renders the `⎿` footer
 * right beneath it. `fileEvent`/`webEvent`/`mcpEvent` carry structured outcomes; `content`
 * is only used for failure messages.
 */
import type { FileToolEvent, McpToolEvent, ProcessToolEvent, WebToolEvent } from "../core/tools";

export type DiffKind = "ctx" | "add" | "del" | "elide";
export type DiffLine = { kind: DiffKind; text: string };

export type ToolKind =
  | "replace"
  | "create"
  | "append"
  | "write"
  | "delete"
  | "copy"
  | "move"
  | "read"
  | "view"
  | "grep"
  | "list"
  | "stat"
  | "web"
  | "mcp"
  | "process"
  | "unknown";

/** Categorise a tool name for rendering decisions. */
export function toolKind(name: string): ToolKind {
  switch (name) {
    case "replace_in_file": return "replace";
    case "create_file": return "create";
    case "create_directory": return "create";
    case "append_file": return "append";
    case "write_file": return "write";
    case "delete_file": return "delete";
    case "delete_directory": return "delete";
    case "copy_file": return "copy";
    case "move_file": return "move";
    case "move_directory": return "move";
    case "read_file": return "read";
    case "view_image": return "view";
    case "grep_files": return "grep";
    case "list_files": return "list";
    case "list_directory": return "list";
    case "stat_path": return "stat";
    case "web_search": return "web";
    case "web_fetch": return "web";
    case "web_map": return "web";
    case "web_crawl": return "web";
    case "web_research": return "web";
    case "shell_exec": return "process";
    case "shell_output": return "process";
    case "shell_stop": return "process";
    default:
      if (name.startsWith("mcp_")) return "mcp";
      return "unknown";
  }
}

/**
 * The 1-based line where the shown content begins in the file, for the
 * line-number gutter. `replace` reads the matched line from `fileEvent`
 * (unknown until the tool reads the file); create/append/write content starts
 * at line 1. Read-only / structural tools have no body, so undefined.
 */
export function resolveStartLine(kind: ToolKind, fileEvent?: FileToolEvent): number | undefined {
  if (kind === "replace") {
    const lines = fileEvent?.matchLines;
    if (lines && lines.length > 0) return lines[0];
    // Backward compat: sessions recorded before the matchLines rename carry a
    // scalar matchLineStart.
    return fileEvent?.matchLineStart;
  }
  if (kind === "create" || kind === "append" || kind === "write") return 1;
  return undefined;
}

/** Parse tool-call arguments JSON into a loose object, or null if unparseable. */
export function parseToolArgs(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

/** The path / arg summary shown after the verb in the `●` header. */
export function toolTarget(name: string, args: Record<string, unknown> | null): string {
  const kind = toolKind(name);
  if (kind === "copy" || kind === "move") {
    const src = str(args?.sourcePath);
    const tgt = str(args?.targetPath);
    return [src, tgt].filter(Boolean).join(" → ");
  }
  if (kind === "grep") {
    const path = str(args?.path);
    const pattern = str(args?.pattern);
    return [path, pattern ? `"${pattern}"` : null].filter(Boolean).join("  ");
  }
  if (kind === "web") return str(args?.query) ?? str(args?.input) ?? str(args?.url) ?? "";
  if (kind === "process") return str(args?.command) ?? str(args?.taskId) ?? "";
  return str(args?.path) ?? "";
}

/**
 * The content body for a mutation tool: a real line-level diff for
 * `replace_in_file`, all-added lines for create/append/write. Returns null for
 * read-only / structural / delete tools (nothing to preview). Output is NOT
 * folded — {@link foldDiffLines} bounds it for display.
 */
export function buildToolBody(name: string, args: Record<string, unknown> | null): DiffLine[] | null {
  const kind = toolKind(name);
  switch (kind) {
    case "replace": {
      const oldText = str(args?.oldText);
      const newText = str(args?.newText);
      if (oldText == null && newText == null) return null;
      return diffText(oldText ?? "", newText ?? "");
    }
    case "create":
    case "append":
    case "write": {
      const content = str(args?.content);
      if (!content) return null;
      return toLines(content).map((text) => ({ kind: "add", text }));
    }
    default:
      return null;
  }
}

/**
 * Line-level LCS diff so shared context between old/new renders once as neutral
 * context (not duplicated as both `-` and `+`). Falls back to a naive
 * old-then-new split when the inputs are too large for the O(n*m) table.
 */
export function diffText(oldText: string, newText: string): DiffLine[] {
  // Treat an empty string as zero lines ("".split("\n") would yield [""]).
  const a = oldText === "" ? [] : toLines(oldText);
  const b = newText === "" ? [] : toLines(newText);
  const n = a.length;
  const m = b.length;

  if (n === 0) return b.map((text) => ({ kind: "add", text }));
  if (m === 0) return a.map((text) => ({ kind: "del", text }));

  // Guard the O(n*m) DP table; for pathological huge blocks, skip LCS.
  if ((n + 1) * (m + 1) > 60_000) {
    return [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  // dp[i][j] = LCS length of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "del", text: a[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "add", text: b[j] });
    j += 1;
  }
  return out;
}

/**
 * Static fold: keep the first and last rows of the body and replace the middle
 * with a single elision marker. No per-block toggle (the immutable message
 * model has no per-block focus); expand-on-demand is a later polish.
 */
export function foldDiffLines(lines: DiffLine[], max: number): DiffLine[] {
  if (lines.length <= max) return lines;
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  const hidden = lines.length - head - tail;
  return [
    ...lines.slice(0, head),
    { kind: "elide", text: `${hidden} more line${hidden === 1 ? "" : "s"}` },
    ...lines.slice(-tail),
  ];
}

/** A diff line annotated with its old/new-file line number (for the git-style gutter). */
export type AnnotatedLine = DiffLine & { oldLine?: number; newLine?: number };

/**
 * Seed both file cursors at `startLine` (the text before the match is unchanged,
 * so old and new positions agree there) and walk the diff. `del` advances the old
 * cursor, `add` the new cursor, `ctx` both. Run on the FULL diff BEFORE folding
 * so visible tail lines keep correct numbers after the elided middle.
 */
export function annotateLineNumbers(lines: DiffLine[], startLine?: number): AnnotatedLine[] {
  if (startLine == null) return lines;
  let oldLine = startLine;
  let newLine = startLine;
  const out: AnnotatedLine[] = [];
  for (const line of lines) {
    if (line.kind === "del") {
      out.push({ ...line, oldLine });
      oldLine += 1;
    } else if (line.kind === "add") {
      out.push({ ...line, newLine });
      newLine += 1;
    } else if (line.kind === "ctx") {
      out.push({ ...line, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Git-style `@@ -start,oldLen +start,newLen @@` hunk header, or null if no position. */
export function hunkHeader(lines: DiffLine[], startLine?: number): string | null {
  if (startLine == null) return null;
  const oldCount = lines.filter((l) => l.kind === "ctx" || l.kind === "del").length;
  const newCount = lines.filter((l) => l.kind === "ctx" || l.kind === "add").length;
  const o = oldCount === 1 ? `${startLine}` : `${startLine},${oldCount}`;
  const n = newCount === 1 ? `${startLine}` : `${startLine},${newCount}`;
  return `@@ -${o} +${n} @@`;
}

/** The `⎿` footer summary. Success reads from `fileEvent`; failure from content. */
export function toolResultFooter(
  name: string,
  ok: boolean,
  content: string,
  fileEvent?: FileToolEvent,
  webEvent?: WebToolEvent,
  mcpEvent?: McpToolEvent,
  processEvent?: ProcessToolEvent,
): string {
  if (processEvent) return processEventDetail(processEvent);
  if (!ok) return joinDetail("failed", firstLine(content));
  if (fileEvent) return fileEventDetail(fileEvent);
  if (webEvent) return webEventDetail(webEvent);
  if (mcpEvent) return mcpEventDetail(mcpEvent);
  return firstLine(content) || joinDetail(name);
}

function processEventDetail(e: ProcessToolEvent): string {
  if (e.status === "running") {
    return joinDetail(
      e.executionMode === "background" && e.taskId ? `background ${e.taskId}` : "running",
      `${formatDuration(e.durationMs)}`,
      e.stdoutBytes + e.stderrBytes > 0 ? `${e.stdoutBytes + e.stderrBytes} bytes` : null,
    );
  }
  return joinDetail(
    e.status === "interrupted" ? "interrupted" : e.timedOut ? "timed out" : e.aborted ? "cancelled" : `exit ${e.exitCode ?? "unknown"}`,
    formatDuration(e.durationMs),
    e.executionMode === "background" && e.taskId ? e.taskId : null,
    e.stdoutTruncated || e.stderrTruncated ? "truncated" : null,
  );
}

export function processPreviewLines(event: ProcessToolEvent, maxLines = 5): Array<{ text: string; stderr: boolean }> {
  const stdout = cleanProcessText(event.stdoutTail ?? "").split("\n").filter(Boolean).map((text) => ({ text, stderr: false }));
  const stderr = cleanProcessText(event.stderrTail ?? "").split("\n").filter(Boolean).map((text) => ({ text, stderr: true }));
  return [...stdout, ...stderr].slice(-maxLines);
}

function cleanProcessText(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function mcpEventDetail(e: McpToolEvent): string {
  return joinDetail("mcp", `${e.serverId}/${e.toolName}`);
}

function webEventDetail(e: WebToolEvent): string {
  if (e.kind === "web_fetch") {
    return joinDetail(
      `fetched ${e.chars} chars`,
      e.truncated ? "truncated" : null,
      hostFromUrl(e.urls[0] ?? ""),
    );
  }
  if (e.kind === "web_map") {
    return joinDetail(
      `${e.resultCount} url${e.resultCount === 1 ? "" : "s"}`,
      hostFromUrl(e.url),
    );
  }
  if (e.kind === "web_crawl") {
    return joinDetail(
      `${e.pageCount} page${e.pageCount === 1 ? "" : "s"}`,
      `${e.chars} chars`,
      e.truncated ? "truncated" : null,
      hostFromUrl(e.url),
    );
  }
  if (e.kind === "web_research") {
    return joinDetail(
      `${e.sourceCount} source${e.sourceCount === 1 ? "" : "s"}`,
      `${e.chars} chars`,
      e.truncated ? "truncated" : null,
    );
  }
  const hosts = [...new Set(e.urls.map(hostFromUrl).filter(Boolean))].slice(0, 3);
  return joinDetail(
    `${e.resultCount} result${e.resultCount === 1 ? "" : "s"}`,
    hosts.length > 0 ? hosts.join(", ") : null,
  );
}

function fileEventDetail(e: FileToolEvent): string {
  const bytes = e.bytes != null ? formatBytes(e.bytes) : null;
  switch (e.operation) {
    case "create": return joinDetail("created", bytes);
    case "write": return joinDetail("wrote", bytes);
    case "replace":
      return joinDetail(e.occurrences != null ? `replaced ${e.occurrences}×` : "replaced", matchLineList(e.matchLines), bytes);
    case "append": return joinDetail("appended", e.deltaBytes != null ? `+${formatBytes(e.deltaBytes)}` : null);
    case "delete": return joinDetail("deleted", bytes);
    case "read": return joinDetail("read", e.lines != null ? `${e.lines} lines` : null);
    case "view": return joinDetail("viewed image", bytes);
    case "grep":
      return joinDetail(
        e.matches != null ? `${e.matches} match${e.matches === 1 ? "" : "es"}` : "grep",
        e.truncated ? "truncated" : null,
      );
    case "list": return joinDetail(e.entryCount != null ? `${e.entryCount} entries` : "listed");
    case "list_directory": return joinDetail(e.entryCount != null ? `${e.entryCount} entries` : "listed directory", e.truncated ? "truncated" : null);
    case "stat": return joinDetail("stat", bytes);
    case "copy": return joinDetail("copied", bytes);
    case "move": return joinDetail("moved", bytes);
    case "create_directory": return joinDetail("created directory");
    case "move_directory": return joinDetail("moved directory");
    case "delete_directory": return joinDetail("deleted directory");
    default: return joinDetail(e.operation);
  }
}

/** Affected-line list for the footer; only multi-occurrence (single is in the gutter). */
function matchLineList(lines?: number[]): string | null {
  if (!lines || lines.length < 2) return null;
  const shown = lines.slice(0, 5).join(", ");
  const more = lines.length > 5 ? ` +${lines.length - 5} more` : "";
  return `at lines ${shown}${more}`;
}

function joinDetail(...parts: Array<string | null | undefined>): string {
  const filtered = parts.filter((p): p is string => Boolean(p));
  return filtered.length > 0 ? filtered.join(" · ") : "ok";
}

function firstLine(value: string): string | null {
  const single = value.replace(/\s+/g, " ").trim();
  if (!single) return null;
  return single.length <= 120 ? single : `${single.slice(0, 117)}...`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function hostFromUrl(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function toLines(text: string): string[] {
  return text.replace(/\r/g, "").split("\n");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
