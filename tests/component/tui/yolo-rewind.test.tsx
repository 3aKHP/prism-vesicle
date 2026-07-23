import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { resolveTuiLayout } from "../../../src/tui/layout";
import { RewindPicker, rewindPickerPanelHeight } from "../../../src/tui/RewindPicker";
import { YoloPrompt, yoloPanelHeight } from "../../../src/tui/YoloPrompt";

describe("tui: yolo and rewind surfaces", () => {
  test("renders the second YOLO danger confirmation", async () => {
    const setup = await testRender(() => <YoloPrompt stage={2} focused="confirm" width={100} />, { width: 100, height: 8 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("DANGER · Enable YOLO (2/2)");
    expect(frame).toContain("Enable YOLO for this process");
    expect(frame).toContain("Rewind cannot guarantee recovery");
    expect(frame).toContain("↑/↓ choose · Enter confirm · Esc cancel");
  });

  test("reserves every YOLO warning row in a narrow terminal", async () => {
    const width = 36;
    const panelHeight = yoloPanelHeight(2, width);
    const setup = await testRender(() => (
      <YoloPrompt stage={2} focused="confirm" width={width} />
    ), { width, height: panelHeight });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(panelHeight).toBe(12);
    expect(resolveTuiLayout(width, 24, true, false, panelHeight).bottomHeight).toBe(panelHeight);
    expect(frame).toContain("Enable YOLO for this process");
    expect(frame).toContain("Cancel");
    expect(frame).toContain("Esc cancel");
    expect(frame.split("\n").at(-2)).toContain("└");
  });

  test("warns when a rewind checkpoint was tainted by shell_exec", async () => {
    const point = {
      uuid: "user-1",
      parentUuid: null,
      content: "run shell",
      timestamp: new Date().toISOString(),
      branchHeadUuid: "head",
      checkpointTainted: true as const,
    };
    const setup = await testRender(() => <RewindPicker state={{
      points: [point],
      selected: 0,
      target: point,
      restoreSelected: 0,
      summaryFeedback: "",
      summaryCursor: 0,
      busy: false,
    }} width={80} />, { width: 80, height: 12 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("ran shell_exec");
    expect(frame).toContain("may not be restored");
  });

  test("renders the rewind message list and current virtual row at 80 columns", async () => {
    const points = [
      {
        uuid: "user-1",
        parentUuid: "root",
        branchHeadUuid: "head",
        content: "看看当前工作区状况。",
        timestamp: new Date().toISOString(),
        diffStats: { filesChanged: [], insertions: 0, deletions: 0 },
      },
      {
        uuid: "user-2",
        parentUuid: "user-1",
        branchHeadUuid: "head",
        content: "请先看图，然后进行一轮高精度的客观文字描述。 [Image #1]",
        timestamp: new Date().toISOString(),
        diffStats: { filesChanged: [], insertions: 0, deletions: 0 },
      },
      {
        uuid: "user-3",
        parentUuid: "user-2",
        branchHeadUuid: "head",
        content: "鞋子不太对。你再看看呢？",
        timestamp: new Date().toISOString(),
        diffStats: { filesChanged: [], insertions: 0, deletions: 0 },
      },
    ];
    const state = {
      points,
      selected: 2,
      restoreSelected: 0,
      summaryFeedback: "",
      summaryCursor: 0,
      busy: false,
    };
    const panelHeight = rewindPickerPanelHeight(state);

    expect(panelHeight).toBe(9);
    const setup = await testRender(() => (
      <RewindPicker
        width={80}
        state={state}
      />
    ), { width: 80, height: panelHeight });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    const rows = frame.split("\n");
    const currentRow = rows.findIndex((line) => line.includes("(current)"));
    const hintRow = rows.findIndex((line) => line.includes("Enter to continue"));
    expect(frame).toContain("Rewind");
    expect(frame).toContain("鞋子不太对");
    expect(frame).toContain("(current)");
    expect(currentRow).toBeGreaterThan(-1);
    expect(hintRow).toBe(currentRow + 1);
  });

  test("reserves enough height for rewind file-restore warnings", async () => {
    const state = {
      points: [],
      selected: 0,
      target: {
        uuid: "user-1",
        parentUuid: "root",
        branchHeadUuid: "head",
        content: "Rewrite the scenario card",
        timestamp: new Date().toISOString(),
        checkpointTainted: true as const,
        diffStats: { filesChanged: ["workspace/scenario.md"], insertions: 8, deletions: 2 },
      },
      restoreSelected: 4,
      summaryFeedback: "",
      summaryCursor: 0,
      busy: false,
    };

    expect(rewindPickerPanelHeight(state)).toBe(14);
    expect(resolveTuiLayout(100, 24, false, true, 9, rewindPickerPanelHeight(state), rewindPickerPanelHeight(state)).bottomHeight).toBe(14);

    const setup = await testRender(() => (
      <RewindPicker
        width={100}
        state={state}
      />
    ), { width: 100, height: 14 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain(">Never mind");
    expect(frame).toContain("Rewinding does not affect files edited manually outside Vesicle tools.");
    expect(frame).toContain("This turn ran shell_exec");
    expect(frame).toContain("↑/↓ choose");
    const rows = frame.split("\n");
    const confirmRow = rows.findIndex((line) => line.includes("Confirm you want"));
    const promptRow = rows.findIndex((line) => line.includes("Rewrite the scenario card"));
    expect(promptRow).toBe(confirmRow + 1);
  });

  test("renders rewind restore failures as a bounded error-only panel", async () => {
    const points = Array.from({ length: 7 }, (_, index) => ({
      uuid: `user-${index}`,
      parentUuid: index === 0 ? null : `user-${index - 1}`,
      branchHeadUuid: "head",
      content: `Prompt ${index}`,
      timestamp: new Date().toISOString(),
      diffStats: { filesChanged: [], insertions: 0, deletions: 0 },
    }));
    const state = {
      points,
      selected: 6,
      target: points[6],
      restoreSelected: 0,
      summaryFeedback: "",
      summaryCursor: 0,
      busy: false,
      error: "Checkpoint restore failed before any files changed",
    };
    const panelHeight = rewindPickerPanelHeight(state);
    const setup = await testRender(() => (
      <RewindPicker width={80} state={state} />
    ), { width: 80, height: panelHeight });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(panelHeight).toBe(8);
    expect(frame).toContain("Error: Checkpoint restore failed");
    expect(frame).toContain("Esc to close");
    expect(frame).not.toContain("Restore the code and/or conversation");
    expect(frame).not.toContain("(current)");
    expect(frame.split("\n").at(-2)).toContain("└");
  });

});
