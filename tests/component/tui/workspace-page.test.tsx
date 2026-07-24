import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { WorkspacePage } from "../../../src/tui/views/WorkspacePage";

describe("tui: workspace page placeholder (B1)", () => {
  test("renders page identity, project root, and the switch hint", async () => {
    const setup = await testRender(() => (
      <WorkspacePage projectRoot="/home/user/my-project" width={100} height={24} />
    ), { width: 100, height: 24 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("WORKSPACE");
    expect(frame).toContain("/home/user/my-project");
    expect(frame).toContain("Ctrl+O");
  });

  test("stays readable at 80 columns", async () => {
    const setup = await testRender(() => (
      <WorkspacePage projectRoot="/home/user/my-project" width={80} height={20} />
    ), { width: 80, height: 20 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("WORKSPACE");
    expect(frame).toContain("Ctrl+O");
  });
});
