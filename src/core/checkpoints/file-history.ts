import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
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
  mode?: number;
};

export type FileCheckpointSnapshot = {
  messageId: string;
  files: Record<string, FileCheckpointEntry>;
  timestamp: string;
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
      this.current.files[normalized] = await capturePath(this.rootDir, this.session.sessionId, normalized);
      changed = true;
    }
    if (changed) await this.persist(true);
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
    const oldContent = before[path] ? await readBackup(rootDir, sessionId, before[path]) : null;
    const newContent = after[path] ? await readBackup(rootDir, sessionId, after[path]) : null;
    if (buffersEqual(oldContent, newContent)) continue;
    result.filesChanged.push(path);
    const counts = lineChangeCounts(oldContent?.toString("utf8") ?? "", newContent?.toString("utf8") ?? "");
    result.insertions += counts.insertions;
    result.deletions += counts.deletions;
  }
  return result;
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
  for (const [path, entry] of Object.entries(state)) {
    const filePath = resolve(rootDir, path);
    const current = await readOptional(filePath);
    const target = await readBackup(rootDir, sessionId, entry);
    if (buffersEqual(current, target)) continue;
    if (target === null) {
      await unlink(filePath).catch((error: unknown) => {
        if (!isEnoent(error)) throw error;
      });
    } else {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, target);
      if (entry.mode !== undefined) await chmod(filePath, entry.mode);
    }
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
    const current = await readOptional(resolve(rootDir, path));
    const target = await readBackup(rootDir, sessionId, entry);
    if (buffersEqual(current, target)) continue;
    result.filesChanged.push(path);
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
  const info = await stat(filePath).catch((error: unknown) => {
    if (isEnoent(error)) return undefined;
    throw error;
  });
  if (!info) return { backup: null };
  if (!info.isFile()) throw new Error(`File checkpoint path is not a file: ${projectPath}`);
  const content = await readFile(filePath);
  const backup = createHash("sha256").update(content).digest("hex");
  const backupDir = join(rootDir, ".vesicle", "file-history", sessionId, "backups");
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(backupDir, backup), content, { flag: "wx" }).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  return { backup, mode: info.mode };
}

async function readBackup(rootDir: string, sessionId: string, entry: FileCheckpointEntry): Promise<Buffer | null> {
  if (entry.backup === null) return null;
  return readFile(join(rootDir, ".vesicle", "file-history", sessionId, "backups", entry.backup));
}

async function readOptional(path: string): Promise<Buffer | null> {
  return readFile(path).catch((error: unknown) => {
    if (isEnoent(error)) return null;
    throw error;
  });
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
