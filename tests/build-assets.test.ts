import { expect, test } from "bun:test";
import { ASSET_ARCHIVE } from "../scripts/build-assets";

test("asset release archive has a stable path", () => {
  expect(ASSET_ARCHIVE).toBe("dist/prism-vesicle-assets.zip");
});
