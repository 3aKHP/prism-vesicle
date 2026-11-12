import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";

export interface LiveBudget {
  schemaVersion: 1;
  maxSessions: 4;
  maxRpcReservations: 16;
  sessionsStarted: number;
  rpcReservations: number;
}

/** Call only while holding the evidence directory's exclusive live-probe lock. */
export async function readLiveBudget(path: string): Promise<LiveBudget> {
  const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  // An empty or malformed existing ledger is corruption, never a fresh budget.
  const budget = existing !== undefined ? JSON.parse(existing) : {
    schemaVersion: 1, maxSessions: 4, maxRpcReservations: 16, sessionsStarted: 0, rpcReservations: 0,
  };
  assert.equal(budget.schemaVersion, 1);
  assert.equal(budget.maxSessions, 4); assert.equal(budget.maxRpcReservations, 16);
  assert(Number.isInteger(budget.sessionsStarted) && budget.sessionsStarted >= 0 && budget.sessionsStarted <= 4);
  assert.equal(budget.rpcReservations, budget.sessionsStarted * 4);
  return budget;
}

/** Persist the reservation before network work. An interrupted temp write leaves the old ledger intact. */
export async function reserveLiveSession(path: string, budget: LiveBudget): Promise<LiveBudget> {
  assert(budget.sessionsStarted < budget.maxSessions, "live session budget exhausted");
  const next = { ...budget, sessionsStarted: budget.sessionsStarted + 1, rpcReservations: budget.rpcReservations + 4 };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(next, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    return next;
  } finally { await rm(temporary, { force: true }); }
}
