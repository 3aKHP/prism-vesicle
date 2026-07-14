import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALLER_FILENAME, INSTALLER_FILE_VERSION, innoCompilerCandidates, numericFileVersion } from "../scripts/build-installer";
import { INSTALLER_PAYLOAD, stageWindowsInstaller } from "../scripts/stage-windows-installer";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Windows guided installer", () => {
  test("declares a stable per-user lifecycle and the complete runtime payload", async () => {
    const source = await readFile(join(import.meta.dir, "..", "installer", "PrismVesicle.iss"), "utf8");
    expect(source).toContain("AppId={{C573D44C-8972-4F71-9027-BD0A1F6C9752}");
    expect(source).toContain("PrivilegesRequired=lowest");
    expect(source).not.toContain("PrivilegesRequiredOverridesAllowed");
    expect(source).toContain("DefaultDirName={localappdata}\\Programs\\Prism Vesicle");
    expect(source).toContain('Source: "{#SourceRoot}\\harness-manifest.json"');
    expect(source).toContain('Source: "{#SourceRoot}\\host-assets\\*"');
    expect(source).toContain('Parameters: "setup"');
    expect(source).toContain('Parameters: "launch"');
    expect(source).toContain("RemoveFromUserPath");
    expect(source).not.toContain("{userappdata}\\prism-vesicle");
  });

  test("stages only the declared distributable payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "vesicle-installer-"));
    roots.push(root);
    await writeFile(join(root, "prism-vesicle.exe"), "pe");
    await writeFile(join(root, "harness-manifest.json"), "{}");
    await writeFile(join(root, "LICENSE"), "license");
    await mkdir(join(root, "assets"));
    await mkdir(join(root, "host-assets"));
    await writeFile(join(root, "assets", "engine.txt"), "engine");
    await writeFile(join(root, "host-assets", "host.txt"), "host");
    const stage = await stageWindowsInstaller(root);
    expect((await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: stage, onlyFiles: true }))).sort()).toEqual([
      "LICENSE",
      "assets/engine.txt",
      "harness-manifest.json",
      "host-assets/host.txt",
      "prism-vesicle.exe",
    ]);
    expect(INSTALLER_PAYLOAD).toEqual(["prism-vesicle.exe", "harness-manifest.json", "assets", "host-assets", "LICENSE"]);
  });

  test("uses a versioned installer filename and supports an explicit compiler", () => {
    expect(INSTALLER_FILENAME).toMatch(/^PrismVesicleSetup-.+-windows-x64\.exe$/);
    expect(INSTALLER_FILE_VERSION).toMatch(/^\d+\.\d+\.\d+\.0$/);
    expect(numericFileVersion("1.2.3-alpha.4")).toBe("1.2.3.0");
    expect(innoCompilerCandidates({ INNO_SETUP_COMPILER: "D:\\Tools\\ISCC.exe" })[0]).toBe("D:\\Tools\\ISCC.exe");
  });
});
