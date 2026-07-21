export type SessionRole = "user" | "assistant" | "system" | "tool";

export type ResumedToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type SessionRecord = {
  uuid: string;
  parentUuid: string | null;
  ts: string;
  sessionId: string;
  role: SessionRole;
  content: string;
  metadata?: Record<string, unknown>;
};

export function normalizeSessionRecords(records: Partial<SessionRecord>[]): SessionRecord[] {
  let previousUuid: string | null = null;
  return records.map((raw, index) => {
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "unknown-session";
    const uuid = typeof raw.uuid === "string" && raw.uuid.length > 0 ? raw.uuid : `${sessionId}:legacy:${index}`;
    const explicitParent = Object.hasOwn(raw, "parentUuid") && (typeof raw.parentUuid === "string" || raw.parentUuid === null);
    const normalized = { ...raw, uuid, parentUuid: explicitParent ? raw.parentUuid! : previousUuid } as SessionRecord;
    previousUuid = normalized.uuid;
    return normalized;
  });
}

export function buildActiveSessionBranch(records: SessionRecord[], options: { headUuid?: string | null } = {}): SessionRecord[] {
  const requestedHead = Object.hasOwn(options, "headUuid") ? options.headUuid ?? null : records.at(-1)?.uuid ?? null;
  if (requestedHead === null) return [];
  const byUuid = new Map(records.map((record) => [record.uuid, record]));
  if (!byUuid.has(requestedHead)) throw new Error(`Session branch head not found: ${requestedHead}`);

  const branch: SessionRecord[] = [];
  const visited = new Set<string>();
  let cursor: string | null = requestedHead;
  while (cursor) {
    if (visited.has(cursor)) throw new Error(`Session branch contains a parent cycle at ${cursor}`);
    visited.add(cursor);
    const record = byUuid.get(cursor);
    if (!record) throw new Error(`Session branch parent not found: ${cursor}`);
    branch.push(record);
    cursor = record.parentUuid;
  }
  return branch.reverse();
}
