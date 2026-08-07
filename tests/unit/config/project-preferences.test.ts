import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  projectPreferencesPath,
  readMcpOutputPersistence,
  readProjectThemePreference,
  unsetProjectThemePreference,
  writeProjectThemePreference,
} from "../../../src/config/project-preferences";

/**
 * Project `.vesicle/preferences.yaml` v1 (plan §8.1, §8.3). The oracle is the
 * file contract: missing file = no override; valid four values parse; malformed
 * / unknown-field / symlink / bad-version produce bounded diagnostics and
 * fallbacks; writes are atomic and refuse unsafe or invalid existing targets.
 */
describe("project theme preferences read", () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "vesicle-prefs-")); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  test("a missing file returns no override", async () => {
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(true);
    expect(read.ok && read.theme).toBeUndefined();
  });

  test("valid four preference values parse", async () => {
    for (const theme of ["dark", "light", "default", "auto"] as const) {
      await writePref(root, `version: 1\ntheme: ${theme}\n`);
      const read = await readProjectThemePreference(root);
      expect(read.ok).toBe(true);
      expect(read.ok && read.theme).toBe(theme);
    }
  });

  test("absent theme means no override", async () => {
    await writePref(root, "version: 1\n");
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(true);
    expect(read.ok && read.theme).toBeUndefined();
  });

  test("missing version is a bounded diagnostic", async () => {
    await writePref(root, "theme: dark\n");
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.diagnostic).toContain("version");
  });

  test("unsupported version is a bounded diagnostic", async () => {
    await writePref(root, "version: 2\ntheme: dark\n");
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.diagnostic).toContain("version");
  });

  test("unknown field is invalid", async () => {
    await writePref(root, "version: 1\ntheme: dark\nprovider: openai\n");
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.diagnostic).toContain("provider");
  });

  test("invalid theme value is invalid", async () => {
    await writePref(root, "version: 1\ntheme: neon\n");
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.diagnostic).toContain("theme");
  });

  test("duplicate field is invalid", async () => {
    await writePref(root, "version: 1\ntheme: dark\ntheme: light\n");
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.diagnostic).toContain("duplicate");
  });

  test("a non-ENOENT stat error on the preference path is a bounded diagnostic, not a thrown crash", async () => {
    // A rootDir that is a regular file makes lstat of <rootDir>/.vesicle/preferences.yaml
    // reject with ENOTDIR (non-ENOENT). Plan §6.3: project config is optional and
    // recoverable — the read must surface a diagnostic, never throw.
    const container = await mkdtemp(join(tmpdir(), "vesicle-prefs-notdir-"));
    try {
      const fileRoot = join(container, "not-a-dir");
      await writeFile(fileRoot, "blocker");
      const read = await readProjectThemePreference(fileRoot);
      expect(read.ok).toBe(false);
      expect(read.ok ? "" : read.diagnostic).toContain("Could not stat");
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });
});

describe("project theme preferences write/unset", () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "vesicle-prefsw-")); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  beforeEach(async () => {
    // Each test starts from a clean preference file so a malformed-state case
    // cannot leak into the next assertion.
    await unlink(projectPreferencesPath(root)).catch(() => {});
  });

  test("persist creates .vesicle and writes a parseable versioned file", async () => {
    await writeProjectThemePreference(root, "auto");
    const path = projectPreferencesPath(root);
    const content = await readFile(path, "utf8");
    expect(content).toContain("version: 1");
    expect(content).toContain("theme: auto");
    const read = await readProjectThemePreference(root);
    expect(read.ok && read.theme).toBe("auto");
  });

  test("persist replaces only a valid existing preference", async () => {
    await writeProjectThemePreference(root, "dark");
    await writeProjectThemePreference(root, "light");
    const read = await readProjectThemePreference(root);
    expect(read.ok && read.theme).toBe("light");
  });

  test("persist refuses to clobber a malformed existing file", async () => {
    await writePref(root, "version: 2\n");
    await expect(writeProjectThemePreference(root, "dark")).rejects.toThrow(/Refusing to overwrite/);
  });

  test("unset removes only theme; an empty preference file is removed", async () => {
    await writeProjectThemePreference(root, "dark");
    const before = await readProjectThemePreference(root);
    expect(before.ok && before.theme).toBe("dark");
    await unsetProjectThemePreference(root);
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(true);
    expect(read.ok && read.theme).toBeUndefined();
    // The file itself was removed (only version: 1 would have remained).
    await expect(stat(projectPreferencesPath(root))).rejects.toThrow();
  });

  test("unset on an already-absent preference is a no-op", async () => {
    await unsetProjectThemePreference(root);
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(true);
  });

  test("unset refuses to modify a malformed file", async () => {
    await writePref(root, "version: 2\ntheme: dark\n");
    await expect(unsetProjectThemePreference(root)).rejects.toThrow(/Refusing to modify/);
  });

  test("unset removes only the theme and preserves mcpOutputPersistence", async () => {
    await writePref(root, "version: 1\ntheme: dark\nmcpOutputPersistence: true\n");
    await unsetProjectThemePreference(root);
    const read = await readProjectThemePreference(root);
    expect(read.ok && read.theme).toBeUndefined();
    expect(read.ok && read.mcpOutputPersistence).toBe(true);
    expect(await readMcpOutputPersistence(root)).toBe(true);
  });

  test(".vesicle/ directory and unrelated state survive unset", async () => {
    await mkdir(join(root, ".vesicle"), { recursive: true });
    await writeFile(join(root, ".vesicle", "sentinel"), "keep me");
    await writeProjectThemePreference(root, "dark");
    await unsetProjectThemePreference(root);
    await expect(readFile(join(root, ".vesicle", "sentinel"), "utf8")).resolves.toBe("keep me");
  });
});

describe("project theme preferences symlink guard", () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "vesicle-prefsym-")); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  test("a symlink preference file is rejected on read", async () => {
    await mkdir(join(root, ".vesicle"), { recursive: true });
    await writeFile(join(root, "real.yaml"), "version: 1\ntheme: dark\n");
    await symlink(join(root, "real.yaml"), projectPreferencesPath(root));
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.diagnostic).toContain("symbolic link");
  });

  test("persist rejects a symlink target", async () => {
    await symlink(join(root, "real.yaml"), projectPreferencesPath(root)).catch(() => {});
    await expect(writeProjectThemePreference(root, "dark")).rejects.toThrow(/symbolic link|Refusing/);
  });
});

describe("project mcp-output-persistence toggle", () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "vesicle-prefs-mcp-")); });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  test("defaults to off when the field or file is absent", async () => {
    await writePref(root, "version: 1\ntheme: dark\n");
    expect(await readMcpOutputPersistence(root)).toBe(false);
    await writePref(root, "version: 1\nmcpOutputPersistence: false\n");
    expect(await readMcpOutputPersistence(root)).toBe(false);
  });

  test("is on only when explicitly true", async () => {
    await writePref(root, "version: 1\nmcpOutputPersistence: true\n");
    expect(await readMcpOutputPersistence(root)).toBe(true);
  });

  test("a malformed value is a bounded diagnostic and reads as off", async () => {
    await writePref(root, "version: 1\nmcpOutputPersistence: maybe\n");
    const read = await readProjectThemePreference(root);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.diagnostic).toContain("mcpOutputPersistence");
    expect(await readMcpOutputPersistence(root)).toBe(false);
  });

  test("writing the theme preserves an existing toggle (no wipe)", async () => {
    await writePref(root, "version: 1\ntheme: dark\nmcpOutputPersistence: true\n");
    expect(await readMcpOutputPersistence(root)).toBe(true);
    await writeProjectThemePreference(root, "light");
    const read = await readProjectThemePreference(root);
    expect(read.ok && read.theme).toBe("light");
    expect(read.ok && read.mcpOutputPersistence).toBe(true);
    // The on-disk file carries both fields.
    const content = await readFile(projectPreferencesPath(root), "utf8");
    expect(content).toContain("theme: light");
    expect(content).toContain("mcpOutputPersistence: true");
  });
});

async function writePref(root: string, content: string): Promise<void> {
  const path = projectPreferencesPath(root);
  await mkdir(join(root, ".vesicle"), { recursive: true });
  await writeFile(path, content, "utf8");
}
