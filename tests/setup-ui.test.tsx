import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { join, resolve } from "node:path";
import { SetupApp, defaultProjectDirectory, maskValue, resolveProjectPath } from "../src/setup/app";

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

  test("uses a Documents project default and expands a home shorthand", () => {
    const env = { USERPROFILE: "C:\\Users\\Tester" };
    expect(defaultProjectDirectory(env)).toBe(join(env.USERPROFILE, "Documents", "PrismVesicle", "MyFirstProject"));
    expect(resolveProjectPath("~/Story", { HOME: env.USERPROFILE })).toBe(resolve(join(env.USERPROFILE, "Story")));
    expect(maskValue("secret-key")).toBe("••••••••••");
    expect(maskValue("secret-key")).not.toContain("secret");
  });

});
