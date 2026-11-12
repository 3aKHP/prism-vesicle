import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "./check";
import type { BaselineEntry } from "./model";

/** File-level backstop: even an entry missed by a domain extractor creates drift. */
export async function scanBaseline(root: string): Promise<BaselineEntry[]> {
  const process = Bun.spawn(["git", "ls-files", "-z", "--", "src", "assets", "host-assets", "docs/examples", "installer", "bin", ".github/workflows", "scripts/build", "scripts/smoke", "package.json", "bun.lock", "harness-manifest.json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [output, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exit !== 0) throw new Error(`baseline scan failed: ${stderr}`);
  const paths = output.split("\0").filter(Boolean).sort();
  return Promise.all(paths.map(async (source) => ({
    id: `FILE:${source}`,
    source,
    sourceHash: sha256(await readFile(resolve(root, source))),
    capabilityIds: [],
    nonCapabilityReason: null,
  })));
}

export function baselineDelta(previous: BaselineEntry[], current: BaselineEntry[]) {
  const old = new Map(previous.map((row) => [row.id, row]));
  const next = new Map(current.map((row) => [row.id, row]));
  return {
    added: current.filter((row) => !old.has(row.id)).map((row) => row.id),
    changed: current.filter((row) => old.has(row.id) && (old.get(row.id)?.sourceHash !== row.sourceHash || old.get(row.id)?.source !== row.source)).map((row) => row.id),
    removed: previous.filter((row) => !next.has(row.id)).map((row) => row.id),
  };
}

/** Baseline snapshots must name a real, clean tracked checkout. */
export async function baselineSha(root: string): Promise<string> {
  async function git(args: string[]) {
    const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`baseline Git inspection failed: ${err}`);
    return out.trim();
  }
  const sha = await git(["rev-parse", "HEAD"]);
  if (await git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("baseline checkout has tracked modifications");
  return sha;
}
