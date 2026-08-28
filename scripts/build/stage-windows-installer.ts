import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

export const INSTALLER_STAGE_DIR = "dist/installer-stage";
export const WINDOWS_EXECUTABLE = "prism-vesicle.exe";
export const INSTALLER_PAYLOAD = [WINDOWS_EXECUTABLE, "harness-manifest.json", "assets", "host-assets", "LICENSE"] as const;
export const INSTALLER_BRAND_INPUTS = ["brand/windows/prism-vesicle.ico", "brand/windows/prism-vesicle-wizard.png"] as const;

export function installerStagingSupported(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

export async function stageWindowsInstaller(rootDir = process.cwd()): Promise<string> {
  const stageDir = resolve(rootDir, INSTALLER_STAGE_DIR);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  for (const path of INSTALLER_PAYLOAD) {
    await cp(resolve(rootDir, path), join(stageDir, path), { recursive: true, force: true });
  }
  for (const path of INSTALLER_BRAND_INPUTS) {
    await cp(resolve(rootDir, path), join(stageDir, path), { recursive: true, force: true });
  }
  const manifest = JSON.parse(await readFile(join(stageDir, "harness-manifest.json"), "utf8")) as unknown;
  if (!manifest || typeof manifest !== "object") throw new Error("Staged Harness manifest is not a JSON object.");
  return stageDir;
}

if (import.meta.main) {
  if (!installerStagingSupported(process.platform)) {
    throw new Error("Installer staging requires the canonical branded PE from a native Windows build; use the contract tests on Linux/WSL.");
  }
  const stageDir = await stageWindowsInstaller();
  console.log(`Staged Windows installer payload: ${stageDir}`);
}
