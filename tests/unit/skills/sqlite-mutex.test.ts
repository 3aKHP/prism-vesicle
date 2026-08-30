import { describe, expect, spyOn, test } from "bun:test";
import {
  isSqliteBusyError,
  type SqliteMutexConnection,
  withSqliteMutexConnection,
} from "../../../src/skills/sqlite-mutex";

interface FakeConnectionOptions {
  exec: (statement: string) => void;
  close?: (force?: boolean) => void;
}

function fakeConnection(options: FakeConnectionOptions): SqliteMutexConnection {
  return {
    exec(statement: string) {
      options.exec(statement);
      return { changes: 0, lastInsertRowid: 0 };
    },
    close(force?: boolean) {
      options.close?.(force);
    },
  };
}

function sqliteError(message: string, fields: { code?: string; errno?: number } = {}): Error {
  return Object.assign(new Error(message), fields);
}

describe("skills SQLite mutex", () => {
  test("runs one critical section and releases only with ROLLBACK", async () => {
    const statements: string[] = [];
    const closeArguments: Array<boolean | undefined> = [];
    let criticalCalls = 0;
    const result = await withSqliteMutexConnection(
      fakeConnection({
        exec: (statement) => statements.push(statement),
        close: (force) => closeArguments.push(force),
      }),
      "locked",
      async () => {
        criticalCalls++;
        return "result";
      },
    );

    expect(result).toBe("result");
    expect(criticalCalls).toBe(1);
    expect(statements).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
    expect(closeArguments).toEqual([false]);
  });

  test("recognizes SQLite busy codes, extended errno, and compatible messages", () => {
    const busyErrors = [
      sqliteError("busy", { code: "SQLITE_BUSY" }),
      sqliteError("busy snapshot", { code: "SQLITE_BUSY_SNAPSHOT" }),
      sqliteError("extended busy", { errno: 5 | (2 << 8) }),
      sqliteError("database is locked"),
      sqliteError("DATABASE IS BUSY"),
    ];
    for (const error of busyErrors) expect(isSqliteBusyError(error)).toBe(true);
    expect(isSqliteBusyError(sqliteError("not a database", { code: "SQLITE_ERROR", errno: 1 }))).toBe(false);
    expect(isSqliteBusyError({ code: "SQLITE_BUSY" })).toBe(false);
  });

  test("retries busy acquisition asynchronously and preserves the result", async () => {
    let beginAttempts = 0;
    let timerRan = false;
    const scheduled = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerRan = true;
        resolve();
      }, 0);
    });
    const result = await withSqliteMutexConnection(
      fakeConnection({
        exec(statement) {
          if (statement === "BEGIN IMMEDIATE" && beginAttempts++ < 2) {
            throw sqliteError("database is locked", { code: "SQLITE_BUSY" });
          }
        },
      }),
      "locked",
      async () => {
        expect(timerRan).toBe(true);
        return 42;
      },
    );
    await scheduled;

    expect(result).toBe(42);
    expect(beginAttempts).toBe(3);
  });

  test("converts only exhausted busy acquisition to the caller lock message", async () => {
    const busyError = sqliteError("database is locked", { code: "SQLITE_BUSY" });
    const now = spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(10_000);
    let criticalCalls = 0;
    try {
      const promise = withSqliteMutexConnection(
        fakeConnection({ exec: () => { throw busyError; } }),
        "caller lock message",
        async () => {
          criticalCalls++;
        },
      );
      const error = await promise.catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("caller lock message");
      expect((error as Error).cause).toBe(busyError);
      expect(criticalCalls).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  test("propagates a non-busy acquisition error without running critical", async () => {
    const acquisitionError = sqliteError("cannot open transaction", { code: "SQLITE_ERROR" });
    let criticalCalls = 0;
    const closeArguments: Array<boolean | undefined> = [];
    const promise = withSqliteMutexConnection(
      fakeConnection({
        exec: () => { throw acquisitionError; },
        close: (force) => closeArguments.push(force),
      }),
      "locked",
      async () => {
        criticalCalls++;
      },
    );

    await expect(promise).rejects.toBe(acquisitionError);
    expect(criticalCalls).toBe(0);
    expect(closeArguments).toEqual([false]);
  });

  test("does not translate a busy-shaped critical-section error", async () => {
    const criticalError = sqliteError("database is busy", { code: "SQLITE_BUSY" });
    const promise = withSqliteMutexConnection(
      fakeConnection({ exec: () => undefined }),
      "caller lock message",
      async () => { throw criticalError; },
    );

    await expect(promise).rejects.toBe(criticalError);
  });

  test("preserves the critical-section error when rollback also fails", async () => {
    const criticalError = new Error("critical failed");
    const promise = withSqliteMutexConnection(
      fakeConnection({
        exec(statement) {
          if (statement === "ROLLBACK") throw new Error("rollback failed");
        },
      }),
      "locked",
      async () => { throw criticalError; },
    );

    await expect(promise).rejects.toBe(criticalError);
  });

  test("returns a successful result when rollback cleanup fails", async () => {
    const result = await withSqliteMutexConnection(
      fakeConnection({
        exec(statement) {
          if (statement === "ROLLBACK") throw new Error("rollback failed");
        },
      }),
      "locked",
      async () => "durable",
    );

    expect(result).toBe("durable");
  });
});
