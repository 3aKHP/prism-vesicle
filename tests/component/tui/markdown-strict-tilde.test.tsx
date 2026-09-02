import { describe, expect, test } from "bun:test";
import { testRender } from "@3akhp/opentui-solid";
import { configureTreeSitterWorkerPath, registerStrictMarkdownInlineParser } from "../../../src/tui/tree-sitter-runtime";
import { MarkdownContent } from "../../../src/tui/widgets/MarkdownContent";

// Register before the first tree-sitter client initializes in this process:
// default-parser overrides are read at client-init time. Single-tilde spans in
// the fixtures carry CJK content because the host's subscript pre-transform
// consumes ASCII single-tilde spans (H~2~O) before the parser ever sees them.
configureTreeSitterWorkerPath();
await registerStrictMarkdownInlineParser();

// The markdown renderable highlights asynchronously through the tree-sitter
// worker; poll the rendered frame until the needle is visible (same pattern
// as markdown-escape.test.tsx).
async function captureFrameWhen(setup: Awaited<ReturnType<typeof testRender>>, needle: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await setup.flush();
    const frame = setup.captureCharFrame();
    if (frame.includes(needle)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return setup.captureCharFrame();
}

describe("MarkdownContent strict double-tilde strikethrough", () => {
  test("renders lone single-tilde prose literally and conceals doubled tildes (tree-sitter path)", async () => {
    const setup = await testRender(
      () => <MarkdownContent content={"正文 ~中文标记~ 与 ~~删除~~ 结尾"} />,
      { width: 40, height: 5 },
    );

    // Under the strict parser the single-tilde delimiters stay visible; the
    // doubled-tilde delimiters are concealed once the highlight lands. Under
    // the stock parser this frame would read "中文标记" without tildes.
    const frame = await captureFrameWhen(setup, "结尾");
    expect(frame).toContain("~中文标记~");
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
