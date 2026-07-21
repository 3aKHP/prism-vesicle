import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeSessionRecords, type SessionRecord } from "./record-model";

export type SessionStore = {
  sessionId: string;
  sessionPath: string;
  append(record: Omit<SessionRecord, "uuid" | "parentUuid" | "ts" | "sessionId">): Promise<SessionRecord>;
  appendMany(records: Array<Omit<SessionRecord, "uuid" | "parentUuid" | "ts" | "sessionId">>): Promise<SessionRecord[]>;
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

  return { sessionId, sessionPath, append: async (record) => (await appendMany([record]))[0]!, appendMany, headUuid: () => headUuid };
}

function serializeSessionAppend<T>(sessionPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionAppendTails.get(sessionPath) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  sessionAppendTails.set(sessionPath, tail);
  void tail.finally(() => {
    if (sessionAppendTails.get(sessionPath) === tail) sessionAppendTails.delete(sessionPath);
  });
  return result;
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
