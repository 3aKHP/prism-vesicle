import { appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { parseHarnessRuntimeIdentity } from "../harness/activation";
import type { HarnessRuntimeIdentity } from "../harness/driver";
import type { SessionStore } from "./append-store";
import type { SessionRecord } from "./record-model";

export const SESSION_MIGRATION_KIND = "session-migration";
export const SESSION_ARCHIVE_KIND = "session-archive";

/** Preflight layers that produced findings, persisted with the migration record. */
export type SessionMigrationPreflightLayer = "resume" | "serializer" | "invariant" | "budget";

/**
 * Record appended to the live session file after a confirmed Harness
 * migration. `from` is null for legacy sessions recorded before Harness
 * identities existed. The verdict is never "blocking": a blocking preflight
 * refuses the migration and nothing is appended.
 */
export type SessionMigrationRecord = {
  migratedAt: string;
  from: HarnessRuntimeIdentity | null;
  to: HarnessRuntimeIdentity;
  /** Project-relative path of the pre-migration archive copy (forward slashes). */
  archivePath: string;
  preflight: {
    verdict: "clean" | "warning";
    warningCount: number;
    layers: SessionMigrationPreflightLayer[];
  };
};

/** Tag appended to the archived copy so it is self-describing without the live file. */
export type SessionArchiveTag = {
  archivedAt: string;
  from: HarnessRuntimeIdentity | null;
  to: HarnessRuntimeIdentity;
  reason: "harness-migration";
};

export function parseSessionMigrationRecord(value: unknown): SessionMigrationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("session migration record must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.migratedAt !== "string" || raw.migratedAt.length === 0) {
    throw new Error("session migration record migratedAt is invalid");
  }
  if (!Object.hasOwn(raw, "from")) throw new Error("session migration record from is missing");
  const from = raw.from === null ? null : parseHarnessRuntimeIdentity(raw.from);
  const to = parseHarnessRuntimeIdentity(raw.to);
  if (typeof raw.archivePath !== "string" || raw.archivePath.length === 0) {
    throw new Error("session migration record archivePath is invalid");
  }
  const preflight = raw.preflight;
  if (!preflight || typeof preflight !== "object" || Array.isArray(preflight)) {
    throw new Error("session migration record preflight is invalid");
  }
  const preflightRaw = preflight as Record<string, unknown>;
  if (preflightRaw.verdict !== "clean" && preflightRaw.verdict !== "warning") {
    throw new Error("session migration record preflight verdict is invalid");
  }
  if (typeof preflightRaw.warningCount !== "number" || !Number.isInteger(preflightRaw.warningCount) || preflightRaw.warningCount < 0) {
    throw new Error("session migration record preflight warningCount is invalid");
  }
  if (!Array.isArray(preflightRaw.layers)) {
    throw new Error("session migration record preflight layers is invalid");
  }
  const layers = preflightRaw.layers.map((layer) => {
    if (layer !== "resume" && layer !== "serializer" && layer !== "invariant" && layer !== "budget") {
      throw new Error("session migration record preflight layer is invalid");
    }
    return layer;
  });
  return { migratedAt: raw.migratedAt, from, to, archivePath: raw.archivePath, preflight: { verdict: preflightRaw.verdict, warningCount: preflightRaw.warningCount, layers } };
}

/** Last confirmed migration wins; malformed migration records fail closed via the strict parser. */
export function findLastSessionMigration(records: SessionRecord[]): SessionMigrationRecord | undefined {
  let last: SessionMigrationRecord | undefined;
  for (const record of records) {
    if (record.metadata?.kind !== SESSION_MIGRATION_KIND) continue;
    last = parseSessionMigrationRecord(record.metadata.migration);
  }
  return last;
}

/**
 * Copy the live session file to `.vesicle/sessions/archive/` byte-for-byte.
 * The copy carries no migration claims yet: the self-describing tag is only
 * appended by {@link appendSessionArchiveTag} after the live-side rebind
 * succeeded, so a failed migration can never leave an archive that names a
 * target baseline the live file never adopted. The archived bytes are written
 * once and never read or modified by the runtime again; the live file is not
 * touched (`appendSessionMigrationRecord` owns the live-side rebind).
 */
export async function archiveSessionBeforeMigration(
  rootDir: string,
  sessionId: string,
): Promise<string> {
  const sessionsDir = join(rootDir, ".vesicle", "sessions");
  const archiveDir = join(sessionsDir, "archive");
  await mkdir(archiveDir, { recursive: true });
  const source = join(sessionsDir, `${sessionId}.jsonl`);
  const archiveName = await claimArchiveName(archiveDir, sessionId, source);
  return `.vesicle/sessions/archive/${archiveName}`;
}

/**
 * Append the self-describing tag to an archived copy after the migration it
 * describes has landed on the live file. A tag-write failure after a
 * successful migration degrades the archive's metadata only; the pre-
 * migration bytes remain intact.
 */
export async function appendSessionArchiveTag(
  rootDir: string,
  archivePath: string,
  sessionId: string,
  tag: SessionArchiveTag,
): Promise<void> {
  const destination = join(rootDir, archivePath);
  const parentUuid = await readLatestArchiveUuid(destination);
  const record: SessionRecord = {
    uuid: crypto.randomUUID(),
    parentUuid,
    ts: tag.archivedAt,
    sessionId,
    role: "system",
    content: `Session archived before migrating its Harness baseline to ${tag.to.packId}@${tag.to.packVersion}.`,
    metadata: { kind: SESSION_ARCHIVE_KIND, archive: tag },
  };
  await appendFile(destination, `${JSON.stringify(record)}\n`, "utf8");
}

/** Append the durable migration record that rebinds the live session's effective Harness identity. */
export async function appendSessionMigrationRecord(
  session: SessionStore,
  record: SessionMigrationRecord,
): Promise<SessionRecord> {
  return session.append({
    role: "system",
    content: migrationSummary(record),
    metadata: { kind: SESSION_MIGRATION_KIND, harness: record.to, migration: record },
  });
}

export function migrationSummary(record: SessionMigrationRecord): string {
  const from = record.from ? `${record.from.packId}@${record.from.packVersion}` : "an unrecorded Harness baseline";
  return `Session Harness baseline migrated from ${from} to ${record.to.packId}@${record.to.packVersion}. Pre-migration transcript archived at ${record.archivePath}.`;
}

/**
 * Reserve `<sessionId>.jsonl` in the archive without overwriting an earlier
 * archive of the same session: re-migrations suffix `-migrated-2`, `-3`, …
 */
async function claimArchiveName(archiveDir: string, sessionId: string, source: string): Promise<string> {
  let candidate = `${sessionId}.jsonl`;
  for (let attempt = 2; ; attempt += 1) {
    try {
      await copyFile(source, join(archiveDir, candidate), constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if (!isFileError(error, "EEXIST")) throw error;
      candidate = `${sessionId}.migrated-${attempt}.jsonl`;
    }
  }
}

async function readLatestArchiveUuid(archivePath: string): Promise<string | null> {
  const text = await readFile(archivePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const last = JSON.parse(lines.at(-1)!) as Partial<SessionRecord>;
  return typeof last.uuid === "string" ? last.uuid : null;
}

function isFileError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
