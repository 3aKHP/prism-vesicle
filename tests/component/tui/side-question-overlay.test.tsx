import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { SideQuestionOverlay } from "../../../src/tui/views/SideQuestionOverlay";
import type { SideQuestionExchange } from "../../../src/tui/side-question-controller";

const completeExchange: SideQuestionExchange = {
  id: "ex-1",
  sessionId: "session-a",
  question: "what is the current phase?",
  answer: "The current phase is blueprint drafting. It is a side answer that wraps across a few lines so the viewport and footer can be checked for overlap at narrow widths.",
  phase: "complete",
  usage: { inputTokens: 120, outputTokens: 40 },
};

describe("SideQuestionOverlay", () => {
  test("renders title, main status, question, answer viewport, and footer at 80 columns without overlap", async () => {
    const setup = await testRender(
      () => (
        <SideQuestionOverlay
          exchange={completeExchange}
          index={0}
          total={2}
          mainStatus="Main: running tools"
          scrollOffset={0}
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
    expect(frame).toContain("blueprint drafting");
    // Usage renders as a distinct dimmed chrome line, never as model output
    // appended to the answer (no underscore-wrapped "_tokens" prose).
    expect(frame).toContain("side tokens ↑120 ↓40");
    expect(frame).not.toContain("_tokens");
    // Footer hint row stays present and stable.
    expect(frame).toContain("Esc close");
    expect(frame).toContain("c copy");
    expect(frame).toContain("x clear");
  });

  test("renders a loading exchange with a thinking indicator", async () => {
    const setup = await testRender(
      () => (
        <SideQuestionOverlay
          exchange={{ ...completeExchange, phase: "loading", answer: "" }}
          index={0}
          total={1}
          mainStatus="Main: idle"
          scrollOffset={0}
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
