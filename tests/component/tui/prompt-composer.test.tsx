import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@3akhp/opentui-core";
import { testRender } from "@3akhp/opentui-solid";
import { PromptComposer, updateComposerCursorOwnership } from "../../../src/tui/PromptComposer";

describe("tui: prompt composer native cursor", () => {
  test("positions the cursor in one-based renderer coordinates", async () => {
    const setup = await testRender(() => (
      <box paddingLeft={3} paddingTop={2}>
        <PromptComposer value="你a" cursor={1} placeholder="Type" width={20} maxLines={2} focused={true} />
      </box>
    ), { width: 40, height: 10 });

    await setup.flush();
    expect(setup.renderer.getCursorState()).toMatchObject({
      x: 6,
      y: 3,
      visible: true,
      style: "line",
      blinking: true,
    });
    expect(setup.captureCharFrame()).toContain("你a");
    expect(setup.captureSpans().lines.flatMap((line) => line.spans)
      .every((span) => (span.attributes & TextAttributes.INVERSE) === 0)).toBe(true);

    setup.resize(40, 12);
    await setup.flush();
    expect(setup.renderer.getCursorState()).toMatchObject({ x: 6, y: 3, visible: true });
    setup.renderer.destroy();
  });

  test("releases and reacquires cursor ownership with focus", () => {
    const calls: unknown[][] = [];
    const renderer = {
      requestRender: () => calls.push(["render"]),
      setCursorPosition: (...args: unknown[]) => calls.push(["position", ...args]),
      setCursorStyle: (...args: unknown[]) => calls.push(["style", ...args]),
    };

    expect(updateComposerCursorOwnership(renderer, false)).toBe(false);
    expect(calls).toEqual([
      ["position", 0, 0, false],
      ["style", { style: "default" }],
    ]);

    calls.length = 0;
    expect(updateComposerCursorOwnership(renderer, true)).toBe(true);
    expect(calls).toEqual([
      ["style", { style: "line", blinking: true }],
      ["render"],
    ]);
  });
});
