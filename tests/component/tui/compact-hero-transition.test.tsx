import { describe, expect, test } from "bun:test";
import { testRender } from "@3akhp/opentui-solid";
import { MessageStream } from "../../../src/tui/views/MessageStream";
import { isEmptySessionTranscript } from "../../../src/tui/session-presenter";
import type { Message } from "../../../src/tui/types";

/**
 * Headless regression for the post-compact Hero defect (issue #107 PR2
 * addendum). The OpenTUI Solid test renderer produces a single frame per mount
 * (a signal update from outside the component does not propagate within one
 * mounted surface, and the scrollbox does not apply sticky-bottom on that first
 * frame), so each stage of the compact sequence is rendered fresh with `showHero`
 * derived from the real invariant (isEmptySessionTranscript).
 *
 * This proves the contract the regression broke: at every stage the real
 * invariant classifies the compact summary as conversation-bearing, so showHero
 * is false, the Hero mark is absent, the transcript is non-blank, and the
 * compact summary renders inside the transcript (not as a fixed Hero notice).
 * The mounted transcript -> Hero -> transcript lifecycle itself (Reproduction B,
 * including the assistant appearing after the next send) is covered by the
 * required real PTY smoke, which is the authority because a headless frame
 * cannot prove scroll/remount behavior.
 */
describe("tui: compact Hero transition", () => {
  const stages: Array<{ name: string; messages: Message[]; transcriptMarker: string }> = [
    {
      name: "long transcript",
      messages: [
        { role: "user", content: "outline chapter one" },
        { role: "assistant", content: "here is the blueprint for chapter one" },
      ],
      transcriptMarker: "outline chapter one",
    },
    {
      name: "compact result replaces history",
      messages: [
        { role: "system", content: "Conversation summary: earlier chapter-one work.", kind: "compact-summary" },
        { role: "system", content: "Conversation compacted into a summary (61 messages)." },
      ],
      transcriptMarker: "Conversation summary",
    },
    {
      name: "next user message after compact",
      messages: [
        { role: "system", content: "Conversation summary: earlier chapter-one work.", kind: "compact-summary" },
        { role: "system", content: "Conversation compacted into a summary (61 messages)." },
        { role: "user", content: "continue from the summary" },
      ],
      transcriptMarker: "Conversation summary",
    },
    {
      name: "assistant reply after compact",
      messages: [
        { role: "system", content: "Conversation summary: earlier chapter-one work.", kind: "compact-summary" },
        { role: "user", content: "continue from the summary" },
        { role: "assistant", content: "advancing to phase one" },
      ],
      transcriptMarker: "Conversation summary",
    },
  ];

  for (const stage of stages) {
    test(`Hero is absent and the transcript renders at: ${stage.name}`, async () => {
      // The real invariant the app uses — not a hardcoded boolean. The
      // regression flipped this to true because the compact summary lost its
      // kind in display projection.
      const showHero = isEmptySessionTranscript(stage.messages);
      expect(showHero, `${stage.name}: must not classify as empty-session`).toBe(false);

      const setup = await testRender(() => (
        <MessageStream
          messages={stage.messages}
          streamingReasoning=""
          streamingAssistant=""
          reasoningMode="collapsed"
          contentWidth={80}
          agents={[]}
          showHero={showHero}
        />
      ), { width: 90, height: 24 });
      await setup.flush();
      const frame = setup.captureCharFrame();
      setup.renderer.destroy();

      // The post-compact regression rendered the centered Hero over the summary
      // and later blanked the region; the invariant fix must keep the Hero off
      // and the transcript non-blank once a compact summary exists.
      expect(frame).not.toContain("one beam in, the spectrum out");
      expect(frame).not.toContain("PRISM VESICLE");
      expect(frame).toMatch(/[A-Za-z]/);
      // The compact summary renders inside the transcript scrollbox, not as a
      // fixed Hero notice above the brand mark.
      expect(frame).toContain(stage.transcriptMarker);
    });
  }

  test("startup notices alone still allow the Hero (real notices are not suppressed)", async () => {
    const messages: Message[] = [{ role: "system", content: "DANGER: YOLO for this process." }];
    expect(isEmptySessionTranscript(messages)).toBe(true);
    const setup = await testRender(() => (
      <MessageStream
        messages={messages}
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
});
