import { describe, expect, test } from "bun:test";
import { testRender } from "@3akhp/opentui-solid";
import { configureTreeSitterWorkerPath, registerStrictMarkdownInlineParser } from "../../../src/tui/tree-sitter-runtime";
import { MarkdownContent } from "../../../src/tui/widgets/MarkdownContent";
import { captureFrameUntil } from "../../support/markdown-frame";

// Register before the first tree-sitter client initializes in this process:
// default-parser overrides are read at client-init time. Single-tilde spans in
// the fixtures carry CJK content because the host's subscript pre-transform
// consumes eligible ASCII single-tilde spans (digit-bearing or
// single-character, such as H~2~O) before the parser ever sees them.
configureTreeSitterWorkerPath();
await registerStrictMarkdownInlineParser();

describe("MarkdownContent strict double-tilde strikethrough", () => {
  test("renders lone single-tilde prose literally and conceals doubled tildes (tree-sitter path)", async () => {
    const setup = await testRender(
      () => <MarkdownContent content={"正文 ~中文标记~ 与 ~~删除~~ 结尾"} />,
      { width: 40, height: 5 },
    );

    // Under the strict parser the single-tilde delimiters stay visible; the
    // doubled-tilde delimiters are concealed once the highlight lands. Under
    // the stock parser this frame would read "中文标记" without tildes. Settle
    // on the post-highlight state — the raw first frames still show ~~删除~~.
    const frame = await captureFrameUntil(setup, (current) => current.includes("~中文标记~") && !current.includes("~~"));
    expect(frame).toContain("删除");
    expect(frame).not.toContain("~~");
    setup.renderer.destroy();
  }, 15_000);

  test("renders lone single-tilde table cells literally and strikes doubled cells (marked path)", async () => {
    const setup = await testRender(
      () => <MarkdownContent content={"| ~甲~ | ~~乙~~ |\n| --- | --- |\n| ~中文~ | ~~删除~~ |"} />,
      { width: 40, height: 8 },
    );
    await setup.flush();

    // Table cells render through the marked inline path, where the
    // strikethrough="double-tilde" option guards the del rule: single-tilde
    // cells keep their delimiters as literal text, doubled cells conceal
    // them and strike the content.
    const frame = setup.captureCharFrame();
    expect(frame).toContain("~中文~");
    expect(frame).toContain("删除");
    expect(frame).not.toContain("~~");
    setup.renderer.destroy();
  }, 15_000);
});
