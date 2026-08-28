import { Database } from "bun:sqlite";

const SQLITE_MUTEX_TIMEOUT_MS = 10_000;
const SQLITE_MUTEX_RETRY_MS = 50;

export type SqliteMutexConnection = Pick<Database, "exec" | "close">;

/**
 * Use an otherwise empty SQLite transaction as a cross-process mutex.
 *
 * The transaction never carries domain data, so release is rollback-only. This
 * avoids reporting a failed COMMIT after the critical section has already made
 * an external atomic file update durable.
 */
export async function withSqliteMutex<T>(
  databasePath: string,
  lockedMessage: string,
  critical: () => Promise<T>,
): Promise<T> {
  const database = new Database(databasePath, { create: true });
  return withSqliteMutexConnection(database, lockedMessage, critical);
}

/** @internal Narrow connection seam for lifecycle tests; not part of the public Skills API. */
export async function withSqliteMutexConnection<T>(
  database: SqliteMutexConnection,
  lockedMessage: string,
  critical: () => Promise<T>,
): Promise<T> {
  let transactionOpen = false;
  try {
    await beginMutexWithRetry(database, lockedMessage);
    transactionOpen = true;
    return await critical();
  } finally {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Closing the connection still releases the mutex. Cleanup must never
        // replace a durable success or the critical section's original error.
      }
    }
    try {
      database.close(false);
    } catch {
      // Preserve the acquisition or critical-section result. No SQLite data is
      // committed by this connection, and close is only lock cleanup.
    }
  }
}

async function beginMutexWithRetry(
  database: SqliteMutexConnection,
  lockedMessage: string,
): Promise<void> {
  const deadline = Date.now() + SQLITE_MUTEX_TIMEOUT_MS;
  while (true) {
    try {
      database.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!isSqliteBusyError(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(lockedMessage, { cause: error });
      }
      await Bun.sleep(SQLITE_MUTEX_RETRY_MS);
    }
  }
}

/** @internal Exported only for direct classification tests in this internal module. */
export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & { code?: unknown; errno?: unknown };
  if (sqliteError.code === "SQLITE_BUSY") return true;
  if (typeof sqliteError.code === "string" && sqliteError.code.startsWith("SQLITE_BUSY_")) return true;
  if (typeof sqliteError.errno === "number" && (sqliteError.errno & 0xff) === 5) return true;
  return /database is locked|database is busy/i.test(error.message);
}
