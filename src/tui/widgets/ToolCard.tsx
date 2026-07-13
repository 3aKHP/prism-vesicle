import { createMemo, For, Show } from "solid-js";
import type { FileToolEvent, McpToolEvent, ProcessToolEvent, WebToolEvent } from "../../core/tools";
import { palette } from "../theme";
import { truncateLine } from "../format";
import type { VesicleImageAttachment } from "../../providers/shared/types";
import {
  annotateLineNumbers,
  buildToolBody,
  foldDiffLines,
  formatDuration,
  hunkHeader,
  parseToolArgs,
  processPreviewLines,
  resolveStartLine,
  toolKind,
  toolResultFooter,
  toolTarget,
  type AnnotatedLine,
} from "../tool-render";

/**
 * Inline tool-call card (Phase D). Tools are cool scaffolding beneath the
 * assistant turn they belong to — so, unlike conversation turns, they carry no
 * role spectrum lane; the `●` and `⎿` glyphs anchor them.
 *
 * The agent loop emits two consecutive events per invocation (tool_call then
 * tool_result), linked by callId. They render as two stacked cards:
 *   - call stage    → `● verb  target` header + git-style folded diff
 *   - result stage  → `⎿ outcome` footer (tight, sits right under the call)
 * The call carries no trailing spacer so the footer attaches; the result
 * carries the spacer that separates one invocation from the next.
 *
 * Content-bearing tools (replace/create/append/write) show a per-line
 * file-line-number gutter; `replace_in_file` additionally shows a
 * `@@ -l,n +l,n @@` hunk header. `replace` line numbers come from the tool's
 * `fileEvent.matchLines`, merged back onto the call card by the result event
 * (so they fill in once the file is read); create/append/write number from 1
 * immediately.
 */
const BODY_MAX = 9;

type Props = {
  toolStage: "call" | "result";
  toolName?: string;
  toolArgs?: string;
  toolOk?: boolean;
  toolFileEvent?: FileToolEvent;
  toolWebEvent?: WebToolEvent;
  toolMcpEvent?: McpToolEvent;
  toolProcessEvent?: ProcessToolEvent;
  /** Raw tool-result content; used only for failure messages. */
  content?: string;
  width: number;
  images?: VesicleImageAttachment[];
};

export function ToolCard(props: Props) {
  if (props.toolStage === "result") {
    const ok = props.toolOk ?? true;
    const footer = toolResultFooter(props.toolName ?? "tool", ok, props.content ?? "", props.toolFileEvent, props.toolWebEvent, props.toolMcpEvent, props.toolProcessEvent);
    return (
      <box flexDirection="column">
        <text content={`  ⎿ ${footer}`} fg={ok ? palette.textMuted : palette.error} />
        <For each={props.images ?? []}>
          {(image, index) => <text content={`    ▧ Image #${index() + 1} · ${image.sourcePath ?? image.filename ?? image.source}`} fg={palette.tool} />}
        </For>
        <text content=" " fg={palette.textDim} />
      </box>
    );
  }

  const name = props.toolName ?? "tool";
  const args = parseToolArgs(props.toolArgs);
  const target = toolTarget(name, args);
  const kind = toolKind(name);
  const raw = buildToolBody(name, args) ?? [];
  // create/append/write resolve to line 1 without the fileEvent, so they render
  // numbered immediately; replace only numbers once matchLines is merged in.
  const startLine = resolveStartLine(kind, props.toolFileEvent);
  const numbered = startLine != null;
  const header = target ? `● ${name}  ${target}` : `● ${name}`;
  const hunk = kind === "replace" && numbered ? hunkHeader(raw, startLine) : null;
  // Annotate on the full diff (so tail lines keep correct numbers after the
  // folded middle), then fold; re-truncate with the terminal width.
  const rows = createMemo(() =>
    foldDiffLines(annotateLineNumbers(raw, startLine), BODY_MAX).map((line) => renderRow(line, props.width, numbered)),
  );

  return (
    <box flexDirection="column">
      <text content={header} fg={palette.tool} attributes={1} />
      <Show when={hunk} fallback={<box height={0} />}>
        <text content={`  ${hunk}`} fg={palette.textDim} />
      </Show>
      <For each={rows()}>{(row) => <text content={row.text} fg={row.fg} />}</For>
      <Show when={kind === "process" ? props.toolProcessEvent : undefined} keyed fallback={<box height={0} />}>
        {(event) => <ProcessOutput event={event} width={props.width} />}
      </Show>
    </box>
  );
}

function ProcessOutput(props: { event: ProcessToolEvent; width: number }) {
  const rows = () => processPreviewLines(props.event);
  const status = () => props.event.status === "running" ? "Running…" : props.event.status;
  return (
    <box flexDirection="column">
      <For each={rows()}>
        {(row) => <text content={`  ${truncateLine(row.text, Math.max(20, props.width - 4))}`} fg={row.stderr ? palette.warn : palette.textMuted} />}
      </For>
      <text
        content={`  ${status()}${props.event.taskId ? ` · ${props.event.taskId}` : ""} · ${formatDuration(props.event.durationMs)}`}
        fg={props.event.status === "running" ? palette.warn : props.event.status === "completed" ? palette.success : palette.error}
      />
    </box>
  );
}

type Row = { text: string; fg: string };

function renderRow(line: AnnotatedLine, width: number, numbered: boolean): Row {
  const isElide = line.kind === "elide";
  const cap = Math.max(20, width - (numbered ? 7 : 4));
  const text = isElide ? `… ${line.text}` : truncateLine(line.text, cap);
  const mark = line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  ";
  const fg =
    line.kind === "add" ? palette.success
      : line.kind === "del" ? palette.error
        : isElide ? palette.textDim
          : palette.textMuted;
  if (!numbered) return { text: `  ${mark}${text}`, fg };
  const num = line.oldLine ?? line.newLine;
  const gutter = num != null ? String(num).padStart(4) : "    ";
  return { text: `${gutter} ${mark}${text}`, fg };
}
