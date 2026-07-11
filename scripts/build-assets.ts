import { mkdir, rm } from "node:fs/promises";

const ASSET_ROOT = "assets";
const OUTPUT_DIR = "dist";
export const ASSET_ARCHIVE = `${OUTPUT_DIR}/prism-vesicle-assets.zip`;

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await rm(ASSET_ARCHIVE, { force: true });

  const command = process.platform === "win32"
    ? [
      "pwsh",
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${ASSET_ROOT}' -DestinationPath '${ASSET_ARCHIVE}' -Force`,
    ]
    : ["zip", "-X", "-q", "-r", ASSET_ARCHIVE, ASSET_ROOT];
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Asset archive command failed (exit ${exitCode}).`);
  if (!(await Bun.file(ASSET_ARCHIVE).exists())) {
    throw new Error(`Asset archive was not created: ${ASSET_ARCHIVE}`);
  }
  console.log(`Packed editable assets: ${ASSET_ARCHIVE}`);
}

if (import.meta.main) await main();
