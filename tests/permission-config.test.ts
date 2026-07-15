import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPermissionSettings } from "../src/config/permissions";

describe("permission settings", () => {
  test("defaults to MOMENTUM with shell disabled when the file is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vesicle-permissions-"));
    try {
      const settings = await loadPermissionSettings({ VESICLE_CONFIG_DIR: dir });
      expect(settings).toMatchObject({ defaultMode: "MOMENTUM", shellExec: false, shellInterpreter: "auto", exists: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads an explicit shell opt-in and conservative default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vesicle-permissions-"));
    try {
      await writeFile(join(dir, "permissions.yaml"), "version: 1\ndefaultMode: INERTIA\nshellExec: true\nshellInterpreter: git-bash\n", "utf8");
      const settings = await loadPermissionSettings({ VESICLE_CONFIG_DIR: dir });
      expect(settings).toMatchObject({ defaultMode: "INERTIA", shellExec: true, shellInterpreter: "git-bash", exists: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses persistent YOLO defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vesicle-permissions-"));
    try {
      await writeFile(join(dir, "permissions.yaml"), "version: 1\ndefaultMode: YOLO\nshellExec: true\n", "utf8");
      await expect(loadPermissionSettings({ VESICLE_CONFIG_DIR: dir })).rejects.toThrow("YOLO cannot be configured");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects unknown shell interpreter profiles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vesicle-permissions-"));
    try {
      await writeFile(join(dir, "permissions.yaml"), "version: 1\ndefaultMode: MOMENTUM\nshellExec: true\nshellInterpreter: fish\n", "utf8");
      await expect(loadPermissionSettings({ VESICLE_CONFIG_DIR: dir })).rejects.toThrow("Invalid permissions shellInterpreter");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
