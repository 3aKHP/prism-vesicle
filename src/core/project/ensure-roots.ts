import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { modelWritableRoots } from "./roots";

export type RootCreationFailure = {
  root: string;
  message: string;
};

/**
 * Create every model-writable project root explicitly at session birth, so the
 * first `<project_state>` observation reads "empty" instead of "absent" for
 * roots nothing has written yet (#291). Best effort by design: a failure (a
 * regular file squatting on the root path, an ACL refusal) is collected, not
 * thrown — the session continues, project state keeps reporting the root
 * honestly as inaccessible/absent, and write tools keep their lazy-mkdir
 * backstop. The read-only `assets` root is excluded; `.vesicle` stays owned by
 * the session stores.
 */
export async function ensureProjectRoots(rootDir: string): Promise<RootCreationFailure[]> {
  const failures: RootCreationFailure[] = [];
  for (const root of modelWritableRoots) {
    try {
      await mkdir(join(rootDir, root), { recursive: true });
    } catch (error) {
      failures.push({ root, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}

/** Shared warning phrasing for every surface that reports creation failures. */
export function formatRootCreationFailure(failure: RootCreationFailure): string {
  return `Project root "${failure.root}" could not be created (${failure.message}); writes under it will fail until the path is fixed.`;
}

/**
 * All failures as one combined notice (one bullet per root) so transcript
 * surfaces append a single system message, matching the instruction-warning
 * notice pattern.
 */
export function formatRootCreationFailures(failures: RootCreationFailure[]): string {
  return failures.map((failure) => `- ${formatRootCreationFailure(failure)}`).join("\n");
}
