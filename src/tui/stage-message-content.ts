export type MessageCommentSegment = {
  id: string;
  kind: "markdown" | "comment";
  raw: string;
  start: number;
  end: number;
};

export type StageHud = {
  start: number;
  end: number;
  summary: string;
};

export type StageMessageContent = {
  segments: MessageCommentSegment[];
  hud?: StageHud;
  hasNeuralChain?: boolean;
  pendingCommentStart?: number;
  pendingHudStart?: number;
};

type MessageCommentScan = {
  segments: MessageCommentSegment[];
  pendingCommentStart?: number;
};

/**
 * Splits complete out-of-code HTML comments without transforming the source.
 * The caller chooses whether comments should be concealed; ordinary messages
 * never opt into this parser's presentation behavior.
 */
export function splitMessageCommentSegments(content: string, messageId: string): MessageCommentSegment[] {
  return scanMessageComments(content, messageId).segments;
}

function scanMessageComments(content: string, messageId: string): MessageCommentScan {
  const segments: MessageCommentSegment[] = [];
  let markdownStart = 0;
  let index = 0;
  let inlineTicks = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let pendingCommentStart: number | undefined;

  const push = (kind: MessageCommentSegment["kind"], start: number, end: number) => {
    if (end <= start) return;
    segments.push({ id: `stage-segment:${messageId}:${segments.length}`, kind, raw: content.slice(start, end), start, end });
  };

  while (index < content.length) {
    if (isLineStart(content, index)) {
      const lineFence = readFence(content, index);
      if (lineFence && (!fence || (lineFence.marker === fence.marker && lineFence.length >= fence.length))) {
        fence = fence ? undefined : lineFence;
        index += lineFence.width;
        continue;
      }
    }

    if (fence) {
      index += 1;
      continue;
    }

    if (content[index] === "`") {
      const run = countRun(content, index, "`");
      if (inlineTicks === 0) inlineTicks = run;
      else if (run === inlineTicks) inlineTicks = 0;
      index += run;
      continue;
    }

    if (inlineTicks === 0 && content.startsWith("<!--", index)) {
      const close = content.indexOf("-->", index + 4);
      if (close >= 0) {
        push("markdown", markdownStart, index);
        const end = close + 3;
        push("comment", index, end);
        markdownStart = end;
        index = end;
        continue;
      }
      pendingCommentStart = index;
      break;
    }

    index += 1;
  }

  push("markdown", markdownStart, content.length);
  return { segments, ...(pendingCommentStart === undefined ? {} : { pendingCommentStart }) };
}

/**
 * Recognizes only the Stage three-part packet. The returned HUD offsets point
 * into the unchanged source string so the renderer can compact it safely.
 */
export function parseStageMessageContent(content: string, messageId: string, streaming = false): StageMessageContent {
  const scan = scanMessageComments(content, messageId);
  const { segments } = scan;
  const neuralChain = segments.find((segment) => segment.kind === "comment" && segment.raw.includes("[!Neural Chain]"));
  if (!neuralChain) {
    const pendingCommentStart = streaming ? scan.pendingCommentStart : undefined;
    return { segments, ...(pendingCommentStart === undefined ? {} : { pendingCommentStart }) };
  }

  const hudStart = skipWhitespace(content, neuralChain.end);
  if (!content.startsWith("【Status】", hudStart)) return { segments, hasNeuralChain: true };
  const hud = readStageHud(content, hudStart);
  if (hud) return { segments, hud, hasNeuralChain: true };
  return streaming
    ? { segments, hasNeuralChain: true, pendingHudStart: hudStart }
    : { segments, hasNeuralChain: true };
}

export function normalStageMarkdownSegments(parsed: StageMessageContent): MessageCommentSegment[] {
  const hiddenStart = parsed.hud?.start ?? parsed.pendingHudStart ?? parsed.pendingCommentStart;
  const hiddenEnd = parsed.hud?.end;
  const visible: MessageCommentSegment[] = [];

  for (const segment of parsed.segments) {
    if (segment.kind === "comment") continue;
    if (hiddenStart === undefined || segment.end <= hiddenStart) {
      visible.push(segment);
      continue;
    }
    if (hiddenEnd === undefined) {
      if (segment.start < hiddenStart) visible.push(sliceSegment(segment, segment.start, hiddenStart, visible.length));
      continue;
    }
    if (segment.start >= hiddenEnd) {
      visible.push(segment);
      continue;
    }
    if (segment.start < hiddenStart) visible.push(sliceSegment(segment, segment.start, hiddenStart, visible.length));
    if (segment.end > hiddenEnd) visible.push(sliceSegment(segment, hiddenEnd, segment.end, visible.length));
  }
  return visible;
}

export type StageNormalRenderPart =
  | { kind: "anchor"; id: string }
  | { kind: "markdown"; segment: MessageCommentSegment };

/**
 * Keeps concealed-comment anchors in source order so MessageStream can retain
 * a reader's exact location while source view changes a comment's height.
 */
export function normalStageRenderParts(parsed: StageMessageContent): StageNormalRenderPart[] {
  const visibleById = new Map(normalStageMarkdownSegments(parsed).map((segment) => [segment.id, segment]));
  const parts: StageNormalRenderPart[] = [];
  for (const segment of parsed.segments) {
    if (segment.kind === "comment") {
      parts.push({ kind: "anchor", id: segment.id });
      continue;
    }
    const direct = visibleById.get(segment.id);
    if (direct) {
      parts.push({ kind: "markdown", segment: direct });
      continue;
    }
    for (const [id, visible] of visibleById) {
      if (id.startsWith(`${segment.id}:visible:`)) parts.push({ kind: "markdown", segment: visible });
    }
  }
  return parts;
}

function readStageHud(content: string, start: number): StageHud | undefined {
  const expected = ["【Status】", "[Space-Time]", "[Physical]", "[Psychology]", "[Beat]", "[Impression]"];
  let cursor = start;
  const lines: string[] = [];
  for (const marker of expected) {
    const next = readLine(content, cursor);
    if (!next || !next.text.startsWith(marker)) return undefined;
    lines.push(next.text);
    cursor = next.end;
  }
  const proseStart = skipWhitespace(content, cursor);
  if (proseStart >= content.length) return undefined;
  const beat = lines[4]!.slice("[Beat]".length).trim();
  const psychology = lines[3]!.slice("[Psychology]".length).trim();
  const detail = [beat, psychology].filter(Boolean).join(" | ");
  return { start, end: cursor, summary: detail ? `Status: ${detail}` : "Status" };
}

function readLine(content: string, start: number): { text: string; end: number } | undefined {
  if (start >= content.length) return undefined;
  const lineEnd = content.indexOf("\n", start);
  if (lineEnd < 0) return { text: content.slice(start).replace(/\r$/, ""), end: content.length };
  return { text: content.slice(start, lineEnd).replace(/\r$/, ""), end: lineEnd + 1 };
}

function sliceSegment(segment: MessageCommentSegment, start: number, end: number, ordinal: number): MessageCommentSegment {
  return { ...segment, id: `${segment.id}:visible:${ordinal}`, raw: segment.raw.slice(start - segment.start, end - segment.start), start, end };
}

function skipWhitespace(content: string, index: number): number {
  while (index < content.length && /\s/.test(content[index]!)) index += 1;
  return index;
}

function isLineStart(content: string, index: number): boolean {
  return index === 0 || content[index - 1] === "\n";
}

function readFence(content: string, index: number): { marker: "`" | "~"; length: number; width: number } | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(content.slice(index));
  if (!match) return undefined;
  const marker = match[2]![0] as "`" | "~";
  return { marker, length: match[2]!.length, width: match[0].length };
}

function countRun(content: string, index: number, marker: string): number {
  let end = index;
  while (content[end] === marker) end += 1;
  return end - index;
}
