import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { SideQuestionOverlay } from "../../../src/tui/views/SideQuestionOverlay";
import type { SideQuestionExchange } from "../../../src/tui/side-question-controller";

const completeExchange: SideQuestionExchange = {
  id: "ex-1",
  sessionId: "session-a",
  question: "what is the current phase?",
  answer: "The current phase is **blueprint drafting**.",
  phase: "complete",
  usage: { inputTokens: 120, outputTokens: 40 },
};

describe("SideQuestionOverlay", () => {
  test("renders title, main status, question, usage chrome, and footer at 80 columns", async () => {
    const setup = await testRender(
      () => (
        <SideQuestionOverlay
          exchange={completeExchange}
          index={0}
          total={2}
          mainStatus="Main: running tools"
          width={80}
          height={20}
        />
      ),
      { width: 80, height: 20 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("BTW · 1/2");
    expect(frame).toContain("Main: running tools");
    expect(frame).toContain("what is the current phase?");
    // Usage renders as a distinct dimmed chrome line, never as model output.
    expect(frame).toContain("side tokens ↑120 ↓40");
    expect(frame).not.toContain("_tokens");
    // Footer hint row stays present and stable.
    expect(frame).toContain("Esc close");
    expect(frame).toContain("c copy");
    expect(frame).toContain("x clear");
    // Note: the answer body renders through OpenTUI's <markdown> element, which
    // the headless testRender harness does not rasterize (same limitation as
    // MessageStream tests). Markdown/highlight rendering is verified in the
    // real terminal, so this frame asserts only the surrounding chrome.
  });

  test("renders a loading exchange with a thinking indicator", async () => {
    const setup = await testRender(
      () => (
        <SideQuestionOverlay
          exchange={{ ...completeExchange, phase: "loading", answer: "" }}
          index={0}
          total={1}
          mainStatus="Main: idle"
          width={80}
          height={16}
        />
      ),
      { width: 80, height: 16 },
    );
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Thinking");
  });
});
