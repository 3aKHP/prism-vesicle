import { displayWidth, segmentGraphemes } from "./format";

export type ComposerVisualLine = {
  text: string;
  start: number;
  end: number;
  width: number;
};

export type ComposerLayout = {
  lines: ComposerVisualLine[];
  visibleLines: ComposerVisualLine[];
  cursorLine: number;
  visibleStart: number;
  hiddenBefore: number;
  hiddenAfter: number;
};

export function layoutComposerText(
  value: string,
  cursor: number,
  columns: number,
  maxVisibleLines: number,
): ComposerLayout {
  const width = Math.max(1, Math.floor(columns));
  const lines = wrapComposerText(value, width);
  const safeCursor = clamp(cursor, 0, value.length);
  const cursorLine = findCursorLine(lines, value, safeCursor);
  const visibleCount = clamp(Math.floor(maxVisibleLines), 1, Math.max(1, lines.length));
  const visibleStart = lines.length <= visibleCount
    ? 0
    : clamp(cursorLine - visibleCount + 1, 0, lines.length - visibleCount);
  const visibleLines = lines.slice(visibleStart, visibleStart + visibleCount);
  return {
    lines,
    visibleLines,
    cursorLine,
    visibleStart,
    hiddenBefore: visibleStart,
    hiddenAfter: Math.max(0, lines.length - visibleStart - visibleLines.length),
  };
}

export function composerVisualLineCount(value: string, columns: number): number {
  return wrapComposerText(value, Math.max(1, Math.floor(columns))).length;
}

export function moveComposerCursorVisual(value: string, cursor: number, direction: -1 | 1, columns: number): number {
  const lines = wrapComposerText(value, Math.max(1, Math.floor(columns)));
  const safeCursor = clamp(cursor, 0, value.length);
  const lineIndex = findCursorLine(lines, value, safeCursor);
  const nextLine = lineIndex + direction;
  if (nextLine < 0 || nextLine >= lines.length) return safeCursor;
  const current = lines[lineIndex];
  const target = lines[nextLine];
  const desiredColumn = displayWidth(value.slice(current.start, safeCursor));
  return offsetForColumn(value, target.start, target.end, desiredColumn);
}

function wrapComposerText(value: string, columns: number): ComposerVisualLine[] {
  const lines: ComposerVisualLine[] = [];
  let logicalStart = 0;

  while (true) {
    const newline = value.indexOf("\n", logicalStart);
    const logicalEnd = newline === -1 ? value.length : newline;
    wrapLogicalLine(value, logicalStart, logicalEnd, columns, lines);
    if (newline === -1) break;
    logicalStart = newline + 1;
  }

  return lines.length > 0 ? lines : [{ text: "", start: 0, end: 0, width: 0 }];
}

function wrapLogicalLine(
  value: string,
  start: number,
  end: number,
  columns: number,
  lines: ComposerVisualLine[],
): void {
  if (start === end) {
    lines.push({ text: "", start, end, width: 0 });
    return;
  }

  let lineStart = start;
  let lineWidth = 0;
  for (const part of graphemeParts(value, start, end)) {
    const partWidth = Math.max(0, displayWidth(part.text));
    if (part.offset > lineStart && lineWidth > 0 && lineWidth + partWidth > columns) {
      lines.push({
        text: value.slice(lineStart, part.offset),
        start: lineStart,
        end: part.offset,
        width: lineWidth,
      });
      lineStart = part.offset;
      lineWidth = 0;
    }
    lineWidth += partWidth;
  }

  lines.push({
    text: value.slice(lineStart, end),
    start: lineStart,
    end,
    width: lineWidth,
  });
}

function findCursorLine(lines: ComposerVisualLine[], value: string, cursor: number): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const isLast = index === lines.length - 1;
    if (cursor < line.start || cursor > line.end) continue;
    if (cursor < line.end) return index;
    if (value[cursor] === "\n" || isLast) return index;
  }
  return Math.max(0, lines.length - 1);
}

function offsetForColumn(value: string, start: number, end: number, column: number): number {
  if (column <= 0) return start;
  let width = 0;
  for (const part of graphemeParts(value, start, end)) {
    const partWidth = Math.max(0, displayWidth(part.text));
    const nextWidth = width + partWidth;
    if (nextWidth > column) return part.offset;
    if (nextWidth === column) return part.nextOffset;
    width = nextWidth;
  }
  return end;
}

type GraphemePart = {
  text: string;
  offset: number;
  nextOffset: number;
};

function graphemeParts(value: string, start: number, end: number): GraphemePart[] {
  const text = value.slice(start, end);
  const parts: GraphemePart[] = [];
  let offset = start;
  for (const part of segmentGraphemes(text)) {
    const nextOffset = offset + part.length;
    parts.push({ text: part, offset, nextOffset });
    offset = nextOffset;
  }
  return parts;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
