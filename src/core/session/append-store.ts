import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { normalizeSessionRecords, type SessionRecord } from "./record-model";

export type SessionStore = {
  sessionId: string;
  sessionPath: string;
  append(record: Omit<SessionRecord, "uuid" | "parentUuid" | "ts" | "sessionId">): Promise<SessionRecord>;
  appendMany(records: Array<Omit<SessionRecord, "uuid" | "parentUuid" | "ts" | "sessionId">>): Promise<SessionRecord[]>;
  appendIfHead(
    expectedHeadUuid: string | null,
    record: Omit<SessionRecord, "uuid" | "parentUuid" | "ts" | "sessionId">,
  ): Promise<SessionRecord>;
  headUuid(): string | null;
};

const sessionAppendTails = new Map<string, Promise<void>>();

export async function createSessionStore(
  rootDir = process.cwd(),
  sessionId = createSessionId(),
  options: { parentUuid?: string | null } = {},
): Promise<SessionStore> {
  const sessionDir = join(rootDir, ".vesicle", "sessions");
  await mkdir(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, `${sessionId}.jsonl`);
  let useExplicitParent = Object.hasOwn(options, "parentUuid");
  let headUuid = useExplicitParent ? options.parentUuid ?? null : await readLatestRecordUuid(sessionPath);

  const appendMany: SessionStore["appendMany"] = async (records) => {
    if (records.length === 0) return [];
    return serializeSessionAppend(sessionPath, async () => {
      let parentUuid = useExplicitParent ? headUuid : await readLatestRecordUuid(sessionPath);
      useExplicitParent = false;
      const lines = records.map((record) => {
        const line: SessionRecord = { uuid: crypto.randomUUID(), parentUuid, ts: new Date().toISOString(), sessionId, ...record };
        parentUuid = line.uuid;
        return line;
      });
      await appendFile(sessionPath, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
      headUuid = lines.at(-1)!.uuid;
      return lines;
    });
  };

  const appendIfHead: SessionStore["appendIfHead"] = async (expectedHeadUuid, record) => {
    return serializeSessionAppend(sessionPath, async () => {
      const actualHeadUuid = await readLatestRecordUuid(sessionPath);
      if (actualHeadUuid !== expectedHeadUuid) {
        throw new Error(
          `Session head changed while preparing the append (expected ${expectedHeadUuid ?? "empty"}, found ${actualHeadUuid ?? "empty"}).`,
        );
      }
      const line: SessionRecord = {
        uuid: crypto.randomUUID(),
        parentUuid: actualHeadUuid,
        ts: new Date().toISOString(),
        sessionId,
        ...record,
      };
      await appendFile(sessionPath, `${JSON.stringify(line)}\n`, "utf8");
      headUuid = line.uuid;
      useExplicitParent = false;
      return line;
    });
  };

  return {
    sessionId,
    sessionPath,
    append: async (record) => (await appendMany([record]))[0]!,
    appendMany,
    appendIfHead,
    headUuid: () => headUuid,
  };
}

function serializeSessionAppend<T>(sessionPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionAppendTails.get(sessionPath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => withSessionFileLock(sessionPath, operation));
  const tail = result.then(() => undefined, () => undefined);
  sessionAppendTails.set(sessionPath, tail);
  void tail.finally(() => {
    if (sessionAppendTails.get(sessionPath) === tail) sessionAppendTails.delete(sessionPath);
  });
  return result;
}

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

/** Serialize the head-read + append transaction across Vesicle processes. */
async function withSessionFileLock<T>(sessionPath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${sessionPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof open>>;
  while (true) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (!isFileError(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the session append lock: ${sessionPath}`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => {
      if (!isFileError(error, "ENOENT")) throw error;
    });
  }
}

function isFileError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function createSessionId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

async function readLatestRecordUuid(sessionPath: string): Promise<string | null> {
  try {
    const text = await readFile(sessionPath, "utf8");
    const records = normalizeSessionRecords(text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as Partial<SessionRecord>));
    return records.at(-1)?.uuid ?? null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
