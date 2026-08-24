/**
 * TUI review flow for a session-Harness migration (#239).
 *
 * Entered from the resume controller when the session's recorded Harness
 * identity differs from the active verified baseline: an offline preflight
 * report is shown behind a two-stage red confirmation (the YOLO/quality
 * rewrite pattern). Confirming archives the pre-migration transcript, appends
 * the durable `session-migration` record, and re-enters resume, which now
 * resolves under the new baseline. Cancelling leaves the session untouched
 * with the picker still open.
 */

import type { Accessor, Setter } from "solid-js";
import type { SessionSummary } from "../core/session/store";
import { createSessionStore } from "../core/session/store";
import {
  appendSessionArchiveTag,
  appendSessionMigrationRecord,
  archiveSessionBeforeMigration,
  type SessionMigrationRecord,
} from "../core/session/session-migration";
import { runSessionMigrationPreflight, type SessionMigrationPreflightReport } from "../core/agent-loop/session-migration-preflight";
import type { SessionMigrationReviewContext } from "./session-resume-controller";
import type { TuiKeyEvent } from "./decision-interaction";

export type MigrationReviewState = {
  stage: 1 | 2;
  focused: "confirm" | "reject";
  target: SessionSummary;
  commandEcho?: string;
  report: SessionMigrationPreflightReport;
  busy: boolean;
};

export type SessionMigrationControllerOptions = {
  rootDir: string;
  migrationReview: Accessor<MigrationReviewState | null>;
  setMigrationReview: Setter<MigrationReviewState | null>;
  setStatus: Setter<string>;
  reportError: (error: unknown) => void;
  /** Re-enter resume after the commit; wired through app.tsx's deferred binding. */
  resumeSession: (target: SessionSummary, commandEcho?: string) => Promise<void>;
};

export function createSessionMigrationController(options: SessionMigrationControllerOptions) {
  async function beginMigrationReview(context: SessionMigrationReviewContext): Promise<void> {
    options.setStatus("checking session compatibility under the new Harness…");
    let report: SessionMigrationPreflightReport;
    try {
      report = await runSessionMigrationPreflight({
        rootDir: options.rootDir,
        sessionId: context.target.sessionId,
        projectHarness: context.projectHarness,
      });
    } catch (error) {
      options.reportError(error);
      return;
    }
    // The safe focus default is the confirm action: the review is the
    // mainstream path off a stranded session, mirroring YOLO/quality rewrite.
    options.setMigrationReview({
      stage: 1,
      focused: "confirm",
      target: context.target,
      ...(context.commandEcho ? { commandEcho: context.commandEcho } : {}),
      report,
      busy: false,
    });
    options.setStatus(report.verdict === "blocking"
      ? "session migration blocked: see the findings below"
      : "session Harness migration review");
  }

  function handleMigrationKey(key: TuiKeyEvent): boolean {
    const state = options.migrationReview();
    if (!state) return false;
    // While the commit is running the panel stays visible but swallows keys,
    // like the quality rewrite confirm during its commit.
    if (state.busy) return true;
    if (key.name === "up" || key.name === "down" || (key.ctrl && (key.name === "p" || key.name === "n"))) {
      options.setMigrationReview({ ...state, focused: state.focused === "confirm" ? "reject" : "confirm" });
      return true;
    }
    if (key.name === "escape") {
      cancelMigration();
      return true;
    }
    if (key.name !== "return" && key.name !== "enter") return false;
    if (state.report.verdict === "blocking") {
      cancelMigration();
      return true;
    }
    if (state.focused === "reject") {
      cancelMigration();
      return true;
    }
    if (state.stage === 1) {
      options.setMigrationReview({ ...state, stage: 2 });
      return true;
    }
    void commitMigration(state);
    return true;
  }

  function cancelMigration(): void {
    options.setMigrationReview(null);
    options.setStatus("resume cancelled; session unchanged");
  }

  async function commitMigration(state: MigrationReviewState): Promise<void> {
    options.setMigrationReview({ ...state, busy: true });
    try {
      const to = state.report.to;
      if (!to) throw new Error("The active verified Harness baseline carries no runtime identity.");
      const now = new Date().toISOString();
      // Order matters for failure honesty: the byte-for-byte archive first
      // (no migration claims), then the live rebind, and only after it lands
      // the self-describing tag — a failed rebind can never leave an archive
      // that names a target the live file never adopted.
      const archivePath = await archiveSessionBeforeMigration(options.rootDir, state.target.sessionId);
      const record: SessionMigrationRecord = {
        migratedAt: now,
        from: state.report.from ?? null,
        to,
        archivePath,
        preflight: {
          verdict: state.report.verdict === "clean" ? "clean" : "warning",
          warningCount: state.report.findings.filter((finding) => finding.severity === "warning").length,
          layers: [...new Set(state.report.findings.map((finding) => finding.layer))],
        },
      };
      await appendSessionMigrationRecord(await createSessionStore(options.rootDir, state.target.sessionId), record);
      await appendSessionArchiveTag(options.rootDir, archivePath, state.target.sessionId, {
        archivedAt: now,
        from: state.report.from ?? null,
        to,
        reason: "harness-migration",
      });
      options.setMigrationReview(null);
      options.setStatus(`session migrated to ${to.packId}@${to.packVersion}`);
      await options.resumeSession(state.target, state.commandEcho);
    } catch (error) {
      options.setMigrationReview(null);
      options.reportError(error);
    }
  }

  return { beginMigrationReview, handleMigrationKey };
}
