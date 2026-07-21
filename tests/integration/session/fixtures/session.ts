import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeSessionFixture(
  sessionDir: string,
  sessionId: string,
  records: Array<{ ts: string; role: string; content: string }>,
): Promise<void> {
  const lines = records.map((record) => JSON.stringify({ ...record, sessionId })).join("\n");
  await writeFile(join(sessionDir, `${sessionId}.jsonl`), `${lines}\n`, "utf8");
}
