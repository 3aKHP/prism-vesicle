import { TextBufferRenderable, type Renderable } from "@3akhp/opentui-core";
import type { ReadingAnchor, ReadingRow } from "./document";

/** Index laid-out text, including concealed Markdown and table cells, by stable leaf and logical line. */
export function renderedReadingRows(content: Renderable): ReadingRow[] {
  const rows: ReadingRow[] = [];
  for (const [block, root] of content.getChildren().entries()) {
    const start = root.screenY - content.screenY;
    const end = start + root.height;
    const anchors = new Map<number, ReadingAnchor>();
    function visit(node: Renderable, path: string): void {
      if (node instanceof TextBufferRenderable) {
        const info = node.lineInfo;
        for (let line = 0; line < info.lineStartCols.length; line += 1) {
          const y = node.screenY - content.screenY + line;
          // The first text leaf on a table/list row anchors the whole row.
          if (!anchors.has(y)) anchors.set(y, { block, node: path, line: info.lineSources[line] ?? 0, offset: info.lineStartCols[line] ?? 0 });
        }
      }
      node.getChildren().forEach((child, index) => { visit(child, `${path}/${index}`); });
    }
    visit(root, "");
    let anchor: ReadingAnchor = { block, node: "", offset: 0 };
    let gap = 0;
    for (let y = start; y < end; y += 1) {
      const next = anchors.get(y);
      if (next) { anchor = next; gap = 0; }
      else gap += 1;
      rows[y] = { ...anchor, gap, text: "", tone: "normal" };
    }
  }
  return rows;
}
