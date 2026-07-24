import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { MessageStream } from "../../../src/tui/views/MessageStream";

/**
 * M2 empty-session hero: visible only while the stream holds no conversation
 * turns; once real messages exist the transcript takes over the area.
 */
describe("tui: empty-session hero", () => {
  test("renders the brand hero while the stream is empty", async () => {
    const setup = await testRender(() => (
      <MessageStream
        messages={[]}
        streamingReasoning=""
        streamingAssistant=""
        reasoningMode="collapsed"
        contentWidth={80}
        agents={[]}
        showHero={true}
      />
    ), { width: 90, height: 24 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("PRISM VESICLE");
    expect(frame).toContain("one beam in, the spectrum out");
    // The compact mark's beam row proves the ANSI mark itself rendered.
    expect(frame).toContain(":%@@%:");
  });

  test("keeps system notices visible above the hero", async () => {
    const setup = await testRender(() => (
      <MessageStream
        messages={[{ role: "system", content: "DANGER: YOLO for this process." }]}
        streamingReasoning=""
        streamingAssistant=""
        reasoningMode="collapsed"
        contentWidth={80}
        agents={[]}
        showHero={true}
      />
    ), { width: 90, height: 24 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("DANGER: YOLO for this process.");
    expect(frame).toContain("one beam in, the spectrum out");
  });

  test("replaces the hero with the transcript once conversation turns exist", async () => {
    const setup = await testRender(() => (
      <MessageStream
        messages={[{ role: "user", content: "outline chapter one" }]}
        streamingReasoning=""
        streamingAssistant=""
        reasoningMode="collapsed"
        contentWidth={80}
        agents={[]}
        showHero={false}
      />
    ), { width: 90, height: 24 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("outline chapter one");
    expect(frame).not.toContain("one beam in, the spectrum out");
  });
});
