// Shared atomic-write primitive for config file mutations.
// Writes go to a uniquely-named sibling staging file and are renamed over the
// target; the staging file is always cleaned up. Callers choose the mode
// (0o600 for secret files like .env, 0o644 otherwise).

import { mkdir, rename, rm, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export async function atomicWrite(path: string, content: string, mode: number = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const staging = `${path}.staging-${randomUUID()}`;
  try {
    await writeFile(staging, content, { encoding: "utf8", flag: "wx", mode });
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}

export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "ENOENT") return;
    throw error;
  }
}
