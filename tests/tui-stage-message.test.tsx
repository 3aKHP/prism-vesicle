import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { Message } from "../src/tui/widgets/Message";

const opening = [
  "Rain tapped the station roof.",
  "\"You came.\"",
  "<!--",
  "## Scene Logic",
  "Keep the old promise unresolved.",
  "-->",
].join("\n");

const packet = [
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

describe("Stage message rendering", () => {
  test("hides opening logic by default and renders exact source when expanded", async () => {
    const normal = await testRender(() => (
      <Message message={{ id: "opening", role: "assistant", content: opening, engine: "stage", kind: "stage-bootstrap-opening" }} reasoningMode="collapsed" width={80} stageSource={false} />
    ), { width: 80, height: 12 });
    await normal.flush();
    const normalFrame = normal.captureCharFrame();
    normal.renderer.destroy();

    expect(normalFrame).toContain("Rain tapped the station roof.");
    expect(normalFrame).not.toContain("Scene Logic");
    expect(normalFrame).not.toContain("<!--");

    const source = await testRender(() => (
      <Message message={{ id: "opening", role: "assistant", content: opening, engine: "stage", kind: "stage-bootstrap-opening" }} reasoningMode="collapsed" width={80} stageSource />
    ), { width: 80, height: 12 });
    await source.flush();
    const sourceFrame = source.captureCharFrame();
    source.renderer.destroy();

    expect(sourceFrame).toContain("<!--");
    expect(sourceFrame).toContain("Scene Logic");
    expect(sourceFrame).toContain("-->");
  });

  test("keeps Stage packet prose primary and preserves the full packet in source view", async () => {
    const normal = await testRender(() => (
      <Message message={{ id: "packet", role: "assistant", content: packet, engine: "stage" }} reasoningMode="collapsed" width={100} />
    ), { width: 100, height: 16 });
    await normal.flush();
    const normalFrame = normal.captureCharFrame();
    normal.renderer.destroy();

    expect(normalFrame).toContain("She held the umbrella closer.");
    expect(normalFrame).toContain("Status:");
    expect(normalFrame).not.toContain("Neural Chain");
    expect(normalFrame).not.toContain("[Space-Time]");

    const source = await testRender(() => (
      <Message message={{ id: "packet", role: "assistant", content: packet, engine: "stage" }} reasoningMode="collapsed" width={100} stageSource />
    ), { width: 100, height: 16 });
    await source.flush();
    const sourceFrame = source.captureCharFrame();
    source.renderer.destroy();

    expect(sourceFrame).toContain("[!Neural Chain]");
    expect(sourceFrame).toContain("[Space-Time]");
    expect(sourceFrame).toContain("<!--");
  });

  test("click toggles a Stage message while a drag retains selection behavior", async () => {
    let toggles = 0;
    const setup = await testRender(() => (
      <Message
        message={{ id: "opening", role: "assistant", content: opening, engine: "stage", kind: "stage-bootstrap-opening" }}
        reasoningMode="collapsed"
        width={80}
        onStageToggle={() => { toggles += 1; }}
      />
    ), { width: 80, height: 12 });
    await setup.flush();
    await setup.mockMouse.click(0, 0);
    expect(toggles).toBe(1);
    await setup.mockMouse.drag(1, 0, 20, 3);
    expect(toggles).toBe(1);
    setup.renderer.destroy();
  });

});
