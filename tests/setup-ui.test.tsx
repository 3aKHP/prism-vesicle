import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { join, resolve } from "node:path";
import {
  SetupApp,
  defaultProjectDirectory,
  maskValue,
  resolveProjectPath,
  setupChoiceSupportsBack,
  setupMultiSelectBackAt,
  setupMultiSelectChoices,
  setupMultiSelectValueAt,
  setupReviewBackIndex,
} from "../src/setup/app";

describe("guided Setup UI", () => {
  test("renders a friendly no-YAML welcome screen", async () => {
    const setup = await testRender(() => <SetupApp onComplete={() => undefined} />, { width: 100, height: 28 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("Prism Vesicle Setup");
    expect(frame).toContain("Begin guided setup");
    expect(frame).toContain("No configuration files to edit");
    expect(frame).toContain("never writes them to YAML");
  });

  test("keeps the welcome flow readable at the supported 80-column width", async () => {
    const setup = await testRender(() => <SetupApp onComplete={() => undefined} />, { width: 80, height: 24 });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("Prism Vesicle Setup");
    expect(frame).toContain("Begin guided setup");
    expect(frame).toContain("Secrets stay in .env");
  });

  test("clips and compacts Setup without overlapping narrow terminal rows", async () => {
    for (const [width, height] of [[60, 18], [48, 14], [36, 12]] as const) {
      const setup = await testRender(() => <SetupApp onComplete={() => undefined} />, { width, height });
      await setup.flush();
      const frame = setup.captureCharFrame();
      setup.renderer.destroy();
      expect(frame).toContain("Prism Vesicle Setup");
      expect(frame).toContain("Begin guided setup");
      expect(frame.split("\n").every((line) => line.length <= width)).toBe(true);
      expect(frame.split("\n")).toHaveLength(height + 1);
    }
  });

  test("offers explicit Back actions and resets review navigation to a valid project choice", () => {
    expect(setupChoiceSupportsBack("discovery-error")).toBe(true);
    expect(setupChoiceSupportsBack("review")).toBe(true);
    const multiSelect = setupMultiSelectChoices(["model-a", "model-b"]);
    expect(multiSelect).toEqual([
      { kind: "value", value: "model-a" },
      { kind: "value", value: "model-b" },
      { kind: "back" },
    ]);
    expect(setupMultiSelectValueAt(multiSelect, 0)).toBe("model-a");
    expect(setupMultiSelectValueAt(multiSelect, 2)).toBeUndefined();
    expect(setupMultiSelectBackAt(multiSelect, 2)).toBe(true);
    expect(setupReviewBackIndex("")).toBe(0);
    expect(setupReviewBackIndex("C:\\Project")).toBe(1);
  });

  test("uses a Documents one-time launch default and expands a home shorthand", () => {
    const env = { USERPROFILE: "C:\\Users\\Tester" };
    expect(defaultProjectDirectory(env)).toBe(join(env.USERPROFILE, "Documents", "PrismVesicle", "MyFirstProject"));
    expect(resolveProjectPath("~/Story", { HOME: env.USERPROFILE })).toBe(resolve(join(env.USERPROFILE, "Story")));
    expect(maskValue("secret-key")).toBe("••••••••••");
    expect(maskValue("secret-key")).not.toContain("secret");
  });
});
