import { describe, expect, test } from "bun:test";
import { normalStageMarkdownSegments, parseStageMessageContent, splitMessageCommentSegments } from "../src/tui/stage-message-content";

const stagePacket = [
  "<!--",
  "[!Neural Chain]",
  "Perception: rain",
  "Instinct: stay",
  "State: first beat",
  "Strategy: listen",
  "-->",
  "【Status】",
  "[Space-Time] night | station",
  "[Physical] cold hands",
  "[Psychology] Tension: 30 | Lens: wary",
  "[Beat] Arrival | Boundary: safe",
  "[Impression] familiar",
  "",
  "She held the umbrella closer.",
].join("\n");

describe("Stage message content", () => {
  test("splits complete comments losslessly in source order", () => {
    const content = "<!-- first -->before<!-- second -->after";
    const segments = splitMessageCommentSegments(content, "message-1");
    expect(segments.map((segment) => segment.kind)).toEqual(["comment", "markdown", "comment", "markdown"]);
    expect(segments.map((segment) => segment.raw).join("")).toBe(content);
    expect(segments.map((segment) => segment.id)).toEqual([
      "stage-segment:message-1:0",
      "stage-segment:message-1:1",
      "stage-segment:message-1:2",
      "stage-segment:message-1:3",
    ]);
  });

  test("keeps comments in fenced and inline code plus unclosed comments literal", () => {
    const content = [
      "`<!-- inline -->`",
      "```md",
      "<!-- fenced -->",
      "```",
      "<!-- unclosed",
    ].join("\n");
    const segments = splitMessageCommentSegments(content, "message-2");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: "markdown", raw: content });
  });

  test("extracts a complete Stage HUD while leaving prose as normal content", () => {
    const parsed = parseStageMessageContent(stagePacket, "message-3");
    expect(parsed.hud?.summary).toContain("Arrival");
    expect(parsed.segments.map((segment) => segment.raw).join("")).toBe(stagePacket);
    expect(normalStageMarkdownSegments(parsed).map((segment) => segment.raw).join("")).toContain("She held the umbrella closer.");
    expect(normalStageMarkdownSegments(parsed).map((segment) => segment.raw).join("")).not.toContain("[!Neural Chain]");
    expect(normalStageMarkdownSegments(parsed).map((segment) => segment.raw).join("")).not.toContain("【Status】");
  });

  test("buffers an incomplete streaming HUD and conceals its completed control comment", () => {
    const partial = stagePacket.slice(0, stagePacket.indexOf("[Impression]"));
    const streaming = parseStageMessageContent(partial, "message-4", true);
    expect(streaming.pendingHudStart).toBeDefined();
    expect(normalStageMarkdownSegments(streaming).map((segment) => segment.raw).join("")).not.toContain("【Status】");
    const completed = parseStageMessageContent(partial, "message-4");
    expect(completed.hasNeuralChain).toBe(true);
    expect(normalStageMarkdownSegments(completed).map((segment) => segment.raw).join("")).toContain("【Status】");
    expect(normalStageMarkdownSegments(completed).map((segment) => segment.raw).join("")).not.toContain("[!Neural Chain]");
  });

  test("folds blank lines around the HUD without stripping prose indentation", () => {
    const packetWithBlanks = [
      "<!--",
      "[!Neural Chain]",
      "State: first beat",
      "-->",
      "",
      "",
      "【Status】",
      "[Space-Time] night",
      "[Physical] cold",
      "[Psychology] Tension: 30",
      "[Beat] Arrival",
      "[Impression] familiar",
      "",
      "",
      "    She held the umbrella closer.",
    ].join("\n");
    const parsed = parseStageMessageContent(packetWithBlanks, "message-blanks");
    expect(normalStageMarkdownSegments(parsed).map((segment) => segment.raw).join("")).toBe("    She held the umbrella closer.");
  });

  test("holds an unfinished streaming comment without treating code text as a comment", () => {
    const partial = "Before\n<!-- [!Neural Chain]\nstate";
    const streaming = parseStageMessageContent(partial, "message-5", true);
    expect(normalStageMarkdownSegments(streaming).map((segment) => segment.raw).join("")).toBe("Before\n");

    const code = "```md\n<!-- [!Neural Chain]\n";
    const codeStreaming = parseStageMessageContent(code, "message-6", true);
    expect(normalStageMarkdownSegments(codeStreaming).map((segment) => segment.raw).join("")).toBe(code);
  });
});
