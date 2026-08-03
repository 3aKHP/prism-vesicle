// Bounded tar/process boundary: extracts an untrusted remote GitHub tarball
// through the system `tar` under a filtered environment, bounded timeout, and
// truncated output capture. No domain knowledge — only process hardening.

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProcessEnvironment, DEFAULT_PROCESS_TIMEOUT_MS, MAX_PROCESS_STREAM_BYTES } from "../../../../core/process/runtime";

/**
 * Extract a gzipped tar `tarGz` into `dest` using the system `tar`. The archive
 * is staged outside `dest` so only the extracted tree remains. Throws if `tar`
 * is missing, reports a non-zero exit, or runs past the host timeout, so a
 * hostile archive cannot hang or flood output. Runs with a filtered environment.
 */
export async function extractTarball(tarGz: Buffer, dest: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const archive = join(tmpdir(), `vesicle-github-${randomUUID()}.tar.gz`);
  await writeFile(archive, tarGz);
  try {
    // --no-same-owner avoids restoring archive ownership (EPERM as non-root, or
    // foreign uid/gid as root). --no-same-permissions is intentionally NOT used:
    // a Skill may bundle executable scripts whose +x bit must survive extraction.
    const result = await runHostCommand(["tar", "--no-same-owner", "-xzf", archive, "-C", dest], { env });
    if (result.timedOut) {
      throw new Error("tar extraction timed out; the archive may be hostile or the disk slow.");
    }
    if (result.exitCode !== 0) {
      throw new Error(`tar extraction failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
  } finally {
    await rm(archive, { force: true }).catch(() => undefined);
  }
}

/**
 * Run a host command under the project's process-hardening policy: a filtered
 * environment (no inherited host secrets), a bounded timeout that kills the
 * child, and truncated output capture. Used for extracting an untrusted remote
 * GitHub tarball; Git invocations stay synchronous because they are local.
 */
async function runHostCommand(
  argv: string[],
  { env, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS }: { env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ exitCode?: number; stdout: string; stderr: string; timedOut: boolean }> {
  const child = Bun.spawn(argv, {
    env: buildProcessEnvironment(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, readBounded(child.stdout), readBounded(child.stderr)]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let kept = 0;
  while (kept < MAX_PROCESS_STREAM_BYTES) {
    const next = await reader.read();
    if (next.done) break;
    const remaining = MAX_PROCESS_STREAM_BYTES - kept;
    const slice = next.value.byteLength <= remaining ? Buffer.from(next.value) : Buffer.from(next.value.subarray(0, remaining));
    chunks.push(slice);
    kept += slice.byteLength;
  }
  try {
    await reader.cancel();
  } catch {
    // Stream already closed after process exit or kill.
  }
  return Buffer.concat(chunks).toString("utf8");
}
