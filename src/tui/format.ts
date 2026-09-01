/**
 * Shared text-formatting helpers for the TUI. Pure functions; no JSX, no
 * reactive state. Extracted so view/widget components and the App shell share
 * one truncation discipline.
 */

/** Scroll window over a folded prompt body (#268 item 4): clamps the offset
 * to the real extent and reports the slice to render plus whether a position
 * indicator row is needed. */
export function bodyScrollWindow(total: number, visible: number, offset: number): {
  start: number;
  end: number;
  folded: boolean;
} {
  const shown = Math.max(1, visible);
  const max = Math.max(0, total - shown);
  const start = Math.max(0, Math.min(max, offset));
  return { start, end: Math.min(total, start + shown), folded: total > shown };
}

/** Position indicator line rendered as the last row of a folded prompt body
 * while the body zone can scroll it. */
export function bodyScrollIndicator(start: number, end: number, total: number, width: number): string {
  return truncateLine(` … lines ${start + 1}-${end} of ${total}`, width);
}

export function truncateLine(value: string, width: number): string {
  const limit = Math.max(8, width);
  if (displayWidth(value) <= limit) return value;
  return `${takeDisplayPrefix(value, limit - 3)}...`;
}

export function truncateMiddle(value: string, width: number): string {
  const limit = Math.max(8, width);
  if (displayWidth(value) <= limit) return value;
  const head = Math.ceil((limit - 3) / 2);
  const tail = Math.floor((limit - 3) / 2);
  return `${takeDisplayPrefix(value, head)}...${takeDisplaySuffix(value, tail)}`;
}

export function padDisplayEnd(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, Math.floor(width) - displayWidth(value)))}`;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function segmentGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
}

export function wrapDisplayLines(value: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const lines: string[] = [];

  for (const rawLine of value.replace(/\r\n?/g, "\n").split("\n")) {
    if (!rawLine) {
      lines.push("");
      continue;
    }

    let line = "";
    let lineWidth = 0;
    for (const char of segmentGraphemes(rawLine)) {
      const charWidth = displayWidth(char);
      if (line && lineWidth + charWidth > limit) {
        const breakAt = line.lastIndexOf(" ");
        if (breakAt > 0) {
          lines.push(line.slice(0, breakAt));
          line = `${line.slice(breakAt + 1)}${char}`.trimStart();
          lineWidth = displayWidth(line);
        } else {
          lines.push(line);
          line = char.trimStart();
          lineWidth = displayWidth(line);
        }
      } else {
        line += char;
        lineWidth += charWidth;
      }
    }
    lines.push(line);
  }

  return lines.length > 0 ? lines : [""];
}

export function visibleDisplayLines(value: string, width: number, maxLines: number): string[] {
  const lines = wrapDisplayLines(value, width);
  const limit = Math.max(1, Math.floor(maxLines));
  if (lines.length <= limit) return lines;
  if (limit === 1) return [truncateLine(`... ${lines.length} lines`, width)];
  if (limit === 2) return [
    lines[0]!,
    truncateLine(`... ${lines.length - 1} more lines`, width),
  ];
  const leading = lines.slice(0, limit - 2);
  return [
    ...leading,
    truncateLine(`... ${lines.length - leading.length - 1} hidden lines`, width),
    lines.at(-1)!,
  ];
}

function takeDisplayPrefix(value: string, width: number): string {
  let result = "";
  let resultWidth = 0;
  for (const char of segmentGraphemes(value)) {
    const charWidth = displayWidth(char);
    if (resultWidth + charWidth > width) break;
    result += char;
    resultWidth += charWidth;
  }
  return result;
}

function takeDisplaySuffix(value: string, width: number): string {
  let result = "";
  let resultWidth = 0;
  for (const char of segmentGraphemes(value).reverse()) {
    const charWidth = displayWidth(char);
    if (resultWidth + charWidth > width) break;
    result = `${char}${result}`;
    resultWidth += charWidth;
  }
  return result;
}

export function displayWidth(value: string): number {
  return Bun.stringWidth(value);
}
