import { describe, expect, test } from "bun:test";
import { testRender } from "@3akhp/opentui-solid";
import { configureTreeSitterWorkerPath } from "../../../src/tui/tree-sitter-runtime";
import { MarkdownContent } from "../../../src/tui/widgets/MarkdownContent";

// The markdown renderable highlights asynchronously through the tree-sitter
// worker; poll the rendered frame until the concealed text is visible (same
// pattern as the markdown-runtime diagnostic's render-until-needle loop).
async function captureFrameWhen(setup: Awaited<ReturnType<typeof testRender>>, needle: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await setup.flush();
    const frame = setup.captureCharFrame();
    if (frame.includes(needle)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return setup.captureCharFrame();
}

describe("MarkdownContent backslash escapes", () => {
  test("renders backslash-escaped punctuation without the literal backslash", async () => {
    configureTreeSitterWorkerPath();
    const setup = await testRender(
      () => <MarkdownContent content={"Escaped \\~ and \\* here"} />,
      { width: 40, height: 5 },
    );

    // Once the worker highlight lands, the escapes decode: the backslash is
    // concealed and the escaped punctuation renders as plain text.
    const frame = await captureFrameWhen(setup, "Escaped ~ and * here");
    expect(frame).toContain("Escaped ~ and * here");
    expect(frame).not.toContain("\\~");
    setup.renderer.destroy();
  }, 15_000);
});
