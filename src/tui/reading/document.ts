import { displayWidth } from "../format";

export type ReadingTone = "normal" | "muted" | "warning" | "danger";
export type ReadingBlock = { text: string; tone?: ReadingTone };
export type ReadingDocument = {
  kind: string;
  identity: unknown;
  key: string;
  title: string;
  blocks: ReadingBlock[];
  hidden: boolean;
  enabled: boolean;
};
export type ReadingAnchor = { block: number; offset: number };
export type ReadingRow = ReadingAnchor & { text: string; tone: ReadingTone };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Keep source offsets while wrapping, so resizing cannot jump to another paragraph. */
export function readingRows(blocks: ReadingBlock[], width: number): ReadingRow[] {
  const rows: ReadingRow[] = [];
  const columns = Math.max(1, width);
  blocks.forEach((block, index) => {
    const source = block.text.replace(/\r\n?/g, "\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
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
      const char = part.segment === "\t" ? "    " : part.segment.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
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
  let result = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.block > anchor.block || (row.block === anchor.block && row.offset > anchor.offset)) break;
    result = index;
  }
  return result;
}
