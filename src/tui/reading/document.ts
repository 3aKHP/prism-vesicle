import { displayWidth } from "../format";

export type ReadingTone = "normal" | "muted" | "warning" | "danger" | "title";
export type ReadingBlock = { text: string; tone?: ReadingTone; format?: "markdown" };
export type ReadingDocument = {
  kind: string;
  identity: unknown;
  key: string;
  title: string;
  blocks: ReadingBlock[];
  hidden: boolean;
  enabled: boolean;
};
export type ReadingAnchor = { block: number; offset: number; node?: string; line?: number; gap?: number };
export type ReadingRow = ReadingAnchor & { text: string; tone: ReadingTone };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function readingText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\t/g, "    ").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Keep source offsets while wrapping, so resizing cannot jump to another paragraph. */
export function readingRows(blocks: ReadingBlock[], width: number): ReadingRow[] {
  const rows: ReadingRow[] = [];
  const columns = Math.max(1, width);
  blocks.forEach((block, index) => {
    const source = readingText(block.text);
    let text = "";
    let offset = 0;
    const push = () => rows.push({ block: index, offset, text, tone: block.tone ?? "normal" });
    for (const part of graphemes.segment(source)) {
      if (part.segment === "\n") {
        push();
        text = "";
        offset = part.index + 1;
        continue;
      }
      const char = part.segment;
      if (text && displayWidth(text + char) > columns) {
        push();
        text = "";
        offset = part.index;
      }
      text += char;
    }
    push();
  });
  return rows;
}

export function readingAnchorIndex(rows: ReadingRow[], anchor: ReadingAnchor): number {
  if (anchor.node !== undefined) {
    let match = -1;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.block !== anchor.block || row.node !== anchor.node) continue;
      if ((row.line ?? 0) > (anchor.line ?? 0)) continue;
      if (row.line === anchor.line && row.offset > anchor.offset) continue;
      if (row.line === anchor.line && row.offset === anchor.offset && (row.gap ?? 0) > (anchor.gap ?? 0)) continue;
      match = index;
    }
    if (match >= 0) return match;
    return Math.max(0, rows.findIndex((row) => row.block === anchor.block));
  }
  let result = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.block > anchor.block || (row.block === anchor.block && row.offset > anchor.offset)) break;
    result = index;
  }
  return result;
}
