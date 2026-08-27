import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cross-domain capability probe for tests that sabotage a fixture with chmod 0
// and rely on the subsequent read failing inside a guarded code path. Top-level
// await resolves before any test module body runs, so test.skipIf sees a
// boolean. Hosts where mode 0 does not deny owner reads (unprivileged Windows,
// or root) cannot make the sabotage work, so those fixtures skip.
export const modeZeroDeniesRead = await (async (): Promise<boolean> => {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-chmod-probe-"));
  try {
    const target = join(dir, "target");
    await writeFile(target, "x", "utf8");
    await chmod(target, 0);
    try {
      await readFile(target, "utf8");
      return false;
    } catch {
      return true;
    }
  } finally {
    await chmod(join(dir, "target"), 0o644).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
})();

// Same-family probe for tests that assert persisted permission bits: hosts
// whose filesystem does not round-trip POSIX modes through chmod/stat (Windows
// maps chmod onto the read-only bit and stats 0o666) cannot assert them.
export const modeBitsPersist = await (async (): Promise<boolean> => {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-mode-probe-"));
  try {
    const target = join(dir, "target");
    await writeFile(target, "x", "utf8");
    await chmod(target, 0o600);
    return ((await stat(target)).mode & 0o777) === 0o600;
  } catch {
    return false;
  } finally {
    await chmod(join(dir, "target"), 0o644).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
})();
