import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { diffLines } from "diff";
import { writableProjectRoots } from "../artifacts/roots";
import {
  buildActiveSessionBranch,
  loadSessionRecords,
  type SessionRecord,
  type SessionStore,
} from "../session/store";

export const MAX_FILE_HISTORY_SNAPSHOTS = 100;

export type FileCheckpointEntry = {
  /** Content-addressed file in .vesicle/file-history/<session>/backups. Null means absent. */
  backup: string | null;
  /** Omitted on legacy snapshots, where backup null meant absent and a hash meant file. */
  kind?: "absent" | "file" | "directory";
  mode?: number;
};

export type FileCheckpointSnapshot = {
  messageId: string;
  files: Record<string, FileCheckpointEntry>;
  timestamp: string;
  /** shell_exec may mutate paths outside the guarded file-tool ledger. */
  taintedByHostProcess?: true;
};

export type FileCheckpointDiffStats = {
  filesChanged: string[];
  insertions: number;
  deletions: number;
};

type SnapshotEnvelope = {
  kind: "file-history-snapshot";
  messageId: string;
  snapshot: FileCheckpointSnapshot;
  isSnapshotUpdate: boolean;
};

export function fileCheckpointingEnabled(): boolean {
  return process.env.VESICLE_DISABLE_FILE_CHECKPOINTING !== "1";
}

/**
 * Owns the checkpoint associated with one user turn. A snapshot is created
 * immediately after the user record is appended and is retroactively extended
 * when that turn touches a previously-untracked file.
 */
export class FileCheckpointManager {
  private current: FileCheckpointSnapshot | null = null;

  constructor(
    private readonly rootDir: string,
    private readonly session: SessionStore,
    private readonly messageId: string,
  ) {}

  static async resumeLatest(rootDir: string, session: SessionStore): Promise<FileCheckpointManager | undefined> {
    if (!fileCheckpointingEnabled()) return undefined;
    const records = await loadSessionRecords(rootDir, session.sessionId);
    const active = buildActiveSessionBranch(records);
    const latest = snapshotsFromRecords(active).at(-1);
    if (!latest) return undefined;
    const manager = new FileCheckpointManager(rootDir, session, latest.messageId);
    manager.current = structuredClone(latest);
    return manager;
  }

  async createSnapshot(): Promise<void> {
    if (!fileCheckpointingEnabled()) return;
    const records = await loadSessionRecords(this.rootDir, this.session.sessionId);
    const active = buildActiveSessionBranch(records, { headUuid: this.messageId });
    const prior = snapshotsFromRecords(active).at(-1);
    const files: Record<string, FileCheckpointEntry> = {};
    for (const path of Object.keys(prior?.files ?? {})) {
      files[path] = await capturePath(this.rootDir, this.session.sessionId, path);
    }
    this.current = { messageId: this.messageId, files, timestamp: new Date().toISOString() };
    await this.persist(false);
  }

  async trackBeforeMutation(paths: string[]): Promise<void> {
    if (!fileCheckpointingEnabled() || !this.current) return;
    let changed = false;
    for (const path of paths) {
      const normalized = normalizeWritablePath(this.rootDir, path);
      if (Object.hasOwn(this.current.files, normalized)) continue;
      const captured = await capturePaths(this.rootDir, this.session.sessionId, normalized);
      for (const [capturedPath, entry] of Object.entries(captured)) {
        if (Object.hasOwn(this.current.files, capturedPath)) continue;
        this.current.files[capturedPath] = entry;
        changed = true;
      }
    }
    if (changed) await this.persist(true);
  }

  async markTaintedByHostProcess(): Promise<void> {
    if (!fileCheckpointingEnabled() || !this.current || this.current.taintedByHostProcess) return;
    this.current.taintedByHostProcess = true;
    await this.persist(true);
  }

  private async persist(isSnapshotUpdate: boolean): Promise<void> {
    if (!this.current) return;
    const envelope: SnapshotEnvelope = {
      kind: "file-history-snapshot",
      messageId: this.messageId,
      snapshot: structuredClone(this.current),
      isSnapshotUpdate,
    };
    await this.session.append({
      role: "system",
      content: "",
      metadata: envelope,
    });
  }
}

export async function fileCheckpointDiffStats(
  rootDir: string,
  sessionId: string,
  messageId: string,
  options: { headUuid?: string | null } = {},
): Promise<FileCheckpointDiffStats | undefined> {
  if (!fileCheckpointingEnabled()) return undefined;
  const state = await checkpointRestoreState(rootDir, sessionId, messageId, options);
  if (!state) return undefined;
  return diffCheckpointState(rootDir, sessionId, state);
}

/** Diff made by one user turn: before this message -> before the next message. */
export async function fileCheckpointTurnDiffStats(
  rootDir: string,
  sessionId: string,
  messageId: string,
  nextMessageId: string | undefined,
  options: { headUuid?: string | null } = {},
): Promise<FileCheckpointDiffStats | undefined> {
  if (!fileCheckpointingEnabled()) return undefined;
  const before = await checkpointRestoreState(rootDir, sessionId, messageId, options);
  if (!before) return undefined;
  if (!nextMessageId) return diffCheckpointState(rootDir, sessionId, before);
  const after = await checkpointRestoreState(rootDir, sessionId, nextMessageId, options);
  if (!after) return undefined;

  const result: FileCheckpointDiffStats = { filesChanged: [], insertions: 0, deletions: 0 };
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const path of paths) {
    const oldEntry = before[path] ?? { backup: null, kind: "absent" };
    const newEntry = after[path] ?? { backup: null, kind: "absent" };
    const oldContent = await entryFileContent(rootDir, sessionId, oldEntry);
    const newContent = await entryFileContent(rootDir, sessionId, newEntry);
    if (entryKind(oldEntry) === entryKind(newEntry) && buffersEqual(oldContent, newContent)) continue;
    result.filesChanged.push(path);
    const counts = lineChangeCounts(oldContent?.toString("utf8") ?? "", newContent?.toString("utf8") ?? "");
    result.insertions += counts.insertions;
    result.deletions += counts.deletions;
  }
  return result;
}

export async function fileCheckpointIsTainted(
  rootDir: string,
  sessionId: string,
  messageId: string,
  options: { headUuid?: string | null } = {},
): Promise<boolean> {
  if (!fileCheckpointingEnabled()) return false;
  const records = await loadSessionRecords(rootDir, sessionId);
  const activeBranch = buildActiveSessionBranch(records, options);
  const snapshot = [...snapshotsFromRecords(activeBranch)]
    .reverse()
    .find((candidate) => candidate.messageId === messageId);
  return snapshot?.taintedByHostProcess === true;
}

export async function restoreFileCheckpoint(
  rootDir: string,
  sessionId: string,
  messageId: string,
  options: { headUuid?: string | null } = {},
): Promise<string[]> {
  if (!fileCheckpointingEnabled()) return [];
  const state = await checkpointRestoreState(rootDir, sessionId, messageId, options);
  if (!state) throw new Error("The selected file checkpoint was not found.");
  const changed: string[] = [];
  const entries = Object.entries(state);

  for (const [path, entry] of [...entries].sort(deepestFirst)) {
    if (entryKind(entry) !== "absent") continue;
    const filePath = resolve(rootDir, path);
    if (!await pathMatchesEntry(filePath, entry, rootDir, sessionId)) {
      await rm(filePath, { recursive: true, force: true });
      changed.push(path);
    }
  }

  for (const [path, entry] of [...entries].sort(shallowestFirst)) {
    if (entryKind(entry) !== "directory") continue;
    const directoryPath = resolve(rootDir, path);
    if (await pathMatchesEntry(directoryPath, entry, rootDir, sessionId)) continue;
    await rm(directoryPath, { recursive: true, force: true });
    await mkdir(directoryPath, { recursive: true });
    if (entry.mode !== undefined) await chmod(directoryPath, entry.mode);
    changed.push(path);
  }

  for (const [path, entry] of entries) {
    if (entryKind(entry) !== "file") continue;
    const filePath = resolve(rootDir, path);
    if (await pathMatchesEntry(filePath, entry, rootDir, sessionId)) continue;
    const target = await readBackup(rootDir, sessionId, entry);
    await rm(filePath, { recursive: true, force: true });
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, target!);
    if (entry.mode !== undefined) await chmod(filePath, entry.mode);
    changed.push(path);
  }
  return changed;
}

async function checkpointRestoreState(
  rootDir: string,
  sessionId: string,
  messageId: string,
  options: { headUuid?: string | null },
): Promise<Record<string, FileCheckpointEntry> | undefined> {
  const records = await loadSessionRecords(rootDir, sessionId);
  const activeBranch = buildActiveSessionBranch(records, options);
  const snapshots = snapshotsFromRecords(activeBranch).slice(-MAX_FILE_HISTORY_SNAPSHOTS);
  const target = [...snapshots].reverse().find((snapshot) => snapshot.messageId === messageId);
  if (!target) return undefined;

  const allPaths = new Set(snapshots.flatMap((snapshot) => Object.keys(snapshot.files)));
  const state: Record<string, FileCheckpointEntry> = {};
  for (const path of allPaths) {
    const targetEntry = target.files[path];
    const earliestKnown = snapshots.find((snapshot) => snapshot.files[path])?.files[path];
    const entry = targetEntry ?? earliestKnown;
    if (entry) state[path] = entry;
  }
  return state;
}

function snapshotsFromRecords(records: SessionRecord[]): FileCheckpointSnapshot[] {
  const snapshots: FileCheckpointSnapshot[] = [];
  const indexByMessage = new Map<string, number>();
  for (const record of records) {
    const envelope = parseEnvelope(record.metadata);
    if (!envelope) continue;
    const existing = indexByMessage.get(envelope.messageId);
    if (envelope.isSnapshotUpdate && existing !== undefined) {
      snapshots[existing] = envelope.snapshot;
      continue;
    }
    indexByMessage.set(envelope.messageId, snapshots.length);
    snapshots.push(envelope.snapshot);
  }
  return snapshots.slice(-MAX_FILE_HISTORY_SNAPSHOTS);
}

async function diffCheckpointState(
  rootDir: string,
  sessionId: string,
  state: Record<string, FileCheckpointEntry>,
): Promise<FileCheckpointDiffStats> {
  const result: FileCheckpointDiffStats = { filesChanged: [], insertions: 0, deletions: 0 };
  for (const [path, entry] of Object.entries(state)) {
    const filePath = resolve(rootDir, path);
    if (await pathMatchesEntry(filePath, entry, rootDir, sessionId)) continue;
    result.filesChanged.push(path);
    const current = await currentFileContent(filePath);
    const target = await entryFileContent(rootDir, sessionId, entry);
    const counts = lineChangeCounts(current?.toString("utf8") ?? "", target?.toString("utf8") ?? "");
    result.insertions += counts.insertions;
    result.deletions += counts.deletions;
  }
  return result;
}

function parseEnvelope(metadata: Record<string, unknown> | undefined): SnapshotEnvelope | undefined {
  if (metadata?.kind !== "file-history-snapshot") return undefined;
  if (typeof metadata.messageId !== "string" || !metadata.snapshot || typeof metadata.snapshot !== "object") return undefined;
  const snapshot = metadata.snapshot as FileCheckpointSnapshot;
  if (snapshot.messageId !== metadata.messageId || !snapshot.files || typeof snapshot.files !== "object") return undefined;
  return {
    kind: "file-history-snapshot",
    messageId: metadata.messageId,
    snapshot,
    isSnapshotUpdate: metadata.isSnapshotUpdate === true,
  };
}

async function capturePath(rootDir: string, sessionId: string, projectPath: string): Promise<FileCheckpointEntry> {
  const filePath = resolve(rootDir, projectPath);
  const info = await lstat(filePath).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (!info) return { backup: null, kind: "absent" };
  if (info.isSymbolicLink()) throw new Error(`File checkpoint path is a symbolic link: ${projectPath}`);
  if (info.isDirectory()) return { backup: null, kind: "directory", mode: info.mode };
  if (!info.isFile()) throw new Error(`File checkpoint path is not a file or directory: ${projectPath}`);
  const content = await readFile(filePath);
  const backup = createHash("sha256").update(content).digest("hex");
  const backupDir = join(rootDir, ".vesicle", "file-history", sessionId, "backups");
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(backupDir, backup), content, { flag: "wx" }).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  return { backup, kind: "file", mode: info.mode };
}

async function capturePaths(
  rootDir: string,
  sessionId: string,
  projectPath: string,
): Promise<Record<string, FileCheckpointEntry>> {
  const result: Record<string, FileCheckpointEntry> = {};
  const entry = await capturePath(rootDir, sessionId, projectPath);
  result[projectPath] = entry;
  if (entryKind(entry) !== "directory") return result;
  const directoryPath = resolve(rootDir, projectPath);
  for (const child of await readdir(directoryPath, { withFileTypes: true })) {
    const childPath = `${projectPath}/${child.name}`;
    Object.assign(result, await capturePaths(rootDir, sessionId, childPath));
  }
  return result;
}

async function readBackup(rootDir: string, sessionId: string, entry: FileCheckpointEntry): Promise<Buffer | null> {
  if (entry.backup === null) return null;
  return readFile(join(rootDir, ".vesicle", "file-history", sessionId, "backups", entry.backup));
}

function entryKind(entry: FileCheckpointEntry): "absent" | "file" | "directory" {
  return entry.kind ?? (entry.backup === null ? "absent" : "file");
}

async function entryFileContent(
  rootDir: string,
  sessionId: string,
  entry: FileCheckpointEntry,
): Promise<Buffer | null> {
  return entryKind(entry) === "file" ? readBackup(rootDir, sessionId, entry) : null;
}

async function currentFileContent(path: string): Promise<Buffer | null> {
  const info = await lstat(path).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  return info?.isFile() ? readFile(path) : null;
}

async function pathMatchesEntry(
  path: string,
  entry: FileCheckpointEntry,
  rootDir: string,
  sessionId: string,
): Promise<boolean> {
  await assertNoLinkedAncestors(rootDir, path);
  const info = await lstat(path).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  const kind = entryKind(entry);
  if (kind === "absent") return !info;
  if (kind === "directory") {
    return Boolean(
      info?.isDirectory()
      && !info.isSymbolicLink()
      && (entry.mode === undefined || info.mode === entry.mode),
    );
  }
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  return buffersEqual(await readFile(path), await readBackup(rootDir, sessionId, entry));
}

async function assertNoLinkedAncestors(rootDir: string, targetPath: string): Promise<void> {
  const root = resolve(rootDir);
  const rel = relative(root, targetPath);
  let current = root;
  for (const part of rel.split(sep).slice(0, -1)) {
    current = resolve(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if (isEnoent(error)) return undefined;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw new Error(`Checkpoint restore path contains a symbolic link: ${relative(root, current).split(sep).join("/")}`);
    }
  }
}

function shallowestFirst(left: [string, FileCheckpointEntry], right: [string, FileCheckpointEntry]): number {
  return left[0].split("/").length - right[0].split("/").length;
}

function deepestFirst(left: [string, FileCheckpointEntry], right: [string, FileCheckpointEntry]): number {
  return right[0].split("/").length - left[0].split("/").length;
}

function normalizeWritablePath(rootDir: string, requestedPath: string): string {
  const root = resolve(rootDir);
  const resolved = resolve(root, requestedPath);
  const rel = relative(root, resolved);
  const normalized = rel.split(sep).join("/");
  const rootName = normalized.split("/")[0];
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || !writableProjectRoots.some((allowed) => allowed === rootName)) {
    throw new Error(`Checkpoint path is outside writable project roots: ${requestedPath}`);
  }
  return normalized;
}

function buffersEqual(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function lineChangeCounts(oldText: string, newText: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const change of diffLines(oldText, newText)) {
    if (change.added) insertions += change.count ?? 0;
    if (change.removed) deletions += change.count ?? 0;
  }
  return { insertions, deletions };
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
