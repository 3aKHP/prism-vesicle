import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { Language, Parser, Query } from "web-tree-sitter";

// Oracle: the product decision for issue #294 (#268 item 5) — lone `~text~`
// renders as literal text and strikethrough requires doubled tildes,
// intentionally stricter than GFM-as-implemented. The strict flavor lives in
// the fork's highlights.strict.scm asset; this contract loads the packaged
// wasm + query directly so a fork regression that silently restores
// single-tilde strikes fails here before any user sees it.
const workerPath = fileURLToPath(import.meta.resolve("@3akhp/opentui-core/parser.worker"));
const inlineAssets = join(dirname(workerPath), "assets", "markdown_inline");

await Parser.init();
const language = await Language.load(join(inlineAssets, "tree-sitter-markdown_inline.wasm"));
const parser = new Parser();
parser.setLanguage(language);

const strictQuery = new Query(language, readFileSync(join(inlineAssets, "highlights.strict.scm"), "utf8"));
const stockQuery = new Query(language, readFileSync(join(inlineAssets, "highlights.scm"), "utf8"));

interface Captures {
  strikethrough: string[];
  concealedPositions: number;
}

function run(query: Query, source: string): Captures {
  const tree = parser.parse(source);
  if (!tree) throw new Error(`markdown_inline parse returned no tree for ${JSON.stringify(source)}`);
  const strikethrough: string[] = [];
  const concealed = new Set<string>();
  for (const match of query.matches(tree.rootNode)) {
    for (const capture of match.captures) {
      const text = source.slice(capture.node.startIndex, capture.node.endIndex);
      if (capture.name === "markup.strikethrough") strikethrough.push(text);
      if (capture.name === "conceal") {
        // Nested strikethrough patterns legitimately conceal one delimiter
        // through two rules; count distinct nodes, not captures.
        concealed.add(`${capture.node.startIndex}:${capture.node.endIndex}`);
      }
    }
  }
  return { strikethrough, concealedPositions: concealed.size };
}

describe("strict double-tilde strikethrough flavor (fork highlights.strict.scm)", () => {
  test("lone single-tilde spans capture no strikethrough and conceal nothing", () => {
    for (const source of ["~x~", "~中文内容~", "a ~text~ b", "H~2~O", "~ spaced ~", "~x~~", "~~x~"]) {
      expect(run(strictQuery, source)).toEqual({ strikethrough: [], concealedPositions: 0 });
    }
  });

  test("doubled tildes strike once and conceal every delimiter", () => {
    const doubled = run(strictQuery, "~~x~~");
    expect(doubled.strikethrough).toEqual(["~~x~~"]);
    expect(doubled.concealedPositions).toBe(4);

    const tripled = run(strictQuery, "~~~x~~~");
    expect(tripled.strikethrough.length).toBeGreaterThan(0);
    expect(tripled.concealedPositions).toBe(6);
  });

  test("emphasis, strong, and code-span delimiter conceal does not regress", () => {
    for (const [source, markers] of [
      ["*em*", 2],
      ["**strong**", 4],
      ["`code`", 2],
      ["_em_", 2],
      ["__strong__", 4],
    ] as const) {
      const captures = run(strictQuery, source);
      expect(captures.strikethrough).toEqual([]);
      expect(captures.concealedPositions).toBe(markers);
    }
  });

  test("known residual: a single-tilde outer wrapping a doubled span still dims (parity with the pre-strict behavior)", () => {
    const nested = run(strictQuery, "~a ~~b~~ c~");
    expect(nested.strikethrough).toEqual(["~a ~~b~~ c~", "~~b~~"]);
    expect(nested.concealedPositions).toBe(6);
  });

  test("the stock query still strikes single tildes, so the strict file is provably not the stock one", () => {
    const stock = run(stockQuery, "~x~");
    expect(stock.strikethrough).toEqual(["~x~"]);
  });
});
