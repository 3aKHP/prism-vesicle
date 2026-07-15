/**
 * Shared text-formatting helpers for the TUI. Pure functions; no JSX, no
 * reactive state. Extracted so view/widget components and the App shell share
 * one truncation discipline.
 */
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
    for (const char of rawLine) {
      const charWidth = displayWidth(char);
      if (line && lineWidth + charWidth > limit) {
        const breakAt = line.lastIndexOf(" ");
        if (breakAt > 0) {
          lines.push(line.slice(0, breakAt));
          line = `${line.slice(breakAt + 1)}${char}`;
          lineWidth = displayWidth(line);
        } else {
          lines.push(line);
          line = char;
          lineWidth = charWidth;
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
  for (const char of value) {
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
  for (const char of [...value].reverse()) {
    const charWidth = displayWidth(char);
    if (resultWidth + charWidth > width) break;
    result = `${char}${result}`;
    resultWidth += charWidth;
  }
  return result;
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const char of [...value]) {
    if (/[\u0300-\u036f]/u.test(char)) continue;
    if (isZeroWidth(char)) continue;
    width += isWideCharacter(char) ? 2 : 1;
  }
  return width;
}

function isZeroWidth(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x200b && code <= 0x200f) ||
    code === 0xfeff ||
    (code >= 0xfe00 && code <= 0xfe0f)
  );
}

function isWideCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}
