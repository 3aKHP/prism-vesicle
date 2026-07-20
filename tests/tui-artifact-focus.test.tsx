import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { ArtifactEntry } from "../src/core/artifacts/workbench";
import { artifactFocusAction, artifactFocusPath, initialArtifactFocusPath } from "../src/tui/artifact-focus";
import { ArtifactFocusPreview, artifactFocusPreviewLines } from "../src/tui/widgets/ArtifactFocusPreview";

const artifacts: ArtifactEntry[] = [
  { path: "workspace/溪因_scenario_want_day.md", updatedAt: "2026-07-20T00:00:00.000Z" },
  { path: "workspace/溪因_字符统计报告.md", updatedAt: "2026-07-20T00:00:00.000Z" },
  { path: "workspace/溪因.md", updatedAt: "2026-07-20T00:00:00.000Z" },
];

describe("artifact sidebar focus", () => {
  test("starts from the selected artifact and clamps directional movement", () => {
    expect(initialArtifactFocusPath(artifacts, artifacts[1]?.path)).toBe(artifacts[1]?.path);
    expect(artifactFocusPath(artifacts, artifacts[0]?.path, -1)).toBe(artifacts[0]?.path);
    expect(artifactFocusPath(artifacts, artifacts[1]?.path, 1)).toBe(artifacts[2]?.path);
  });

  test("reserves focus navigation and preview keys", () => {
    expect(artifactFocusAction({ name: "up" })).toBe("previous");
    expect(artifactFocusAction({ name: "enter" })).toBe("preview");
    expect(artifactFocusAction({ name: "escape" })).toBe("exit");
    expect(artifactFocusAction({ name: "a", option: true })).toBe("exit");
  });

  test("wraps the focused CJK path without truncating it", () => {
    const path = artifacts[0]!.path;
    const lines = artifactFocusPreviewLines(path, 30);
    expect(lines.join("")).toBe(path);
    expect(lines.length).toBeGreaterThan(1);
  });

  test("renders the current path in a full-width transient strip", async () => {
    const path = artifacts[0]!.path;
    const setup = await testRender(() => <ArtifactFocusPreview path={path} index={0} total={artifacts.length} width={30} />, { width: 30, height: 6 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();

    expect(frame).toContain("Artifact 1/3");
    expect(frame).toContain("workspace/");
    expect(frame).toContain("scenario");
    expect(frame).toContain("day.md");
  });
});
