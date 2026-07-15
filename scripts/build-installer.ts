import { access } from "node:fs/promises";
import { resolve } from "node:path";
import packageJson from "../package.json";
import { stageWindowsInstaller, WINDOWS_EXECUTABLE } from "./stage-windows-installer";

export const INSTALLER_FILENAME = `PrismVesicleSetup-${packageJson.version}-windows-x64.exe`;
export const INSTALLER_FILE_VERSION = numericFileVersion(packageJson.version);

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} failed with exit code ${exitCode}.`);
}

export function innoCompilerCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.INNO_SETUP_COMPILER,
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ].filter((value): value is string => Boolean(value));
}

async function findInnoCompiler(): Promise<string> {
  for (const candidate of innoCompilerCandidates()) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error("Inno Setup 6 compiler not found. Install it or set INNO_SETUP_COMPILER to ISCC.exe.");
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The Inno installer must be compiled on Windows. Use build:installer:stage on Linux/WSL.");
  }
  await run([process.execPath, "run", "scripts/build-exe.ts", "windows"]);
  await access(resolve(WINDOWS_EXECUTABLE));
  const stageDir = await stageWindowsInstaller();
  const outputDir = resolve("dist");
  const compiler = await findInnoCompiler();
  await run([
    compiler,
    "/Qp",
    `/DAppVersion=${packageJson.version}`,
    `/DFileVersion=${INSTALLER_FILE_VERSION}`,
    `/DSourceRoot=${stageDir}`,
    `/DOutputDir=${outputDir}`,
    resolve("installer/PrismVesicle.iss"),
  ]);
  const output = resolve(outputDir, INSTALLER_FILENAME);
  await access(output);
  console.log(`Built Windows installer: ${output}`);
}

if (import.meta.main) await main();

export function numericFileVersion(version: string): string {
  const parts = version.split("-", 1)[0].split(".").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65535)) {
    throw new Error(`Cannot derive a Windows file version from ${version}.`);
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}
