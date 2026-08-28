import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WINDOWS_ICON_FRAMES, WINDOWS_ICON_SCHEMA, WINDOWS_WIZARD_SIZE } from "../../../brand/windows/icon-source.manifest";
import { buildWindowsIcons, verifyWindowsIconRegeneration } from "../../../scripts/build/build-windows-icon";

const root = join(import.meta.dir, "..", "..", "..");

describe("Windows brand assets", () => {
  test("keeps the canonical ICO frame inventory and SVG source split", async () => {
    expect(WINDOWS_ICON_FRAMES.map((frame) => frame.size)).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);
    expect(WINDOWS_ICON_FRAMES.filter((frame) => frame.size < 64).every((frame) => frame.source === "mono")).toBe(true);
    expect(WINDOWS_ICON_FRAMES.filter((frame) => frame.size >= 64).every((frame) => frame.source === "mark")).toBe(true);

    const ico = await readFile(join(root, "brand", "windows", "prism-vesicle.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(WINDOWS_ICON_FRAMES.length);
    const encodedSizes = WINDOWS_ICON_FRAMES.map((_, index) => ico.readUInt8(6 + index * 16) || 256);
    expect(encodedSizes).toEqual(WINDOWS_ICON_FRAMES.map((frame) => frame.size));
  });

  test("keeps tracked sources and outputs aligned with the hash manifest", async () => {
    await expect(buildWindowsIcons(true)).resolves.toBeUndefined();
    const manifest = await Bun.file(join(root, "brand", "windows", "icon-build.json")).json();
    expect(manifest.schema).toBe(WINDOWS_ICON_SCHEMA);
    expect(manifest.renderer).toBe("@resvg/resvg-js@2.6.2");
    expect(manifest.wizard.size).toBe(WINDOWS_WIZARD_SIZE);
  });

  test("regenerates the canonical ICO, wizard image, and manifest byte-identically", async () => {
    expect(await verifyWindowsIconRegeneration()).toBe(true);
  });
});
