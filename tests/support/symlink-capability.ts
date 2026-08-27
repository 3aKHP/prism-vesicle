import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cross-domain capability probe for tests whose fixtures need real symbolic links.
// Top-level await resolves before any test module body runs, so test.skipIf always
// sees a boolean. A fixture skips only when creating a symlink genuinely fails on
// this host (e.g. unprivileged Windows), never by platform blanket rule, so a
// Windows host with developer mode still runs the real assertions.
export const symlinkCapable = await (async (): Promise<boolean> => {
  const dir = await mkdtemp(join(tmpdir(), "vesicle-symlink-probe-"));
  try {
    const target = join(dir, "target");
    await writeFile(target, "x", "utf8");
    await symlink(target, join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();
