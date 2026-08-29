import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot, createSignal } from "solid-js";
import { AssetResolver } from "../../../src/core/runtime/assets";
import { createSessionStore, listSessions, loadSessionSnapshot } from "../../../src/core/session/store";
import type { SessionRecord } from "../../../src/core/session/record-model";
import type { SessionSummary } from "../../../src/core/session/store";
import type { ProjectHarnessRuntime } from "../../../src/core/harness/activation";
import type { HarnessRuntimeIdentity } from "../../../src/core/harness/driver";
import { createSessionResumeController } from "../../../src/tui/session-resume-controller";
import { createSessionMigrationController } from "../../../src/tui/session-migration-controller";
import type { MigrationReviewState } from "../../../src/tui/session-migration-controller";
import { runSessionMigrationPreflight } from "../../../src/core/agent-loop/session-migration-preflight";
import { configureFixtureProvider } from "../harness/fixtures/harness";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";
import type { Message } from "../../../src/tui/types";

function identity(version: string, sha: string, adapterVersion: string): HarnessRuntimeIdentity {
  return {
    packId: "prism-engine-v10",
    packVersion: version,
    sourceCommit: "integration",
    manifestSha256: sha,
    adapterId: "vesicle-v1",
    adapterVersion,
    adapterHash: "b".repeat(64),
  };
}

const baselineA = identity("10.3.0-alpha.2", "a".repeat(64), "1.1.0");
const baselineB = identity("10.3.1", "c".repeat(64), "1.2.0");

async function migrationRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vesicle-session-migration-e2e-"));
  await mkdir(join(root, "assets", "prompts", "shared"), { recursive: true });
  await mkdir(join(root, "assets", "prompts", "engines"), { recursive: true });
  await mkdir(join(root, "assets", "engines"), { recursive: true });
  await writeFile(join(root, "assets", "prompts", "shared", "vesicle-base.md"), "base", "utf8");
  await writeFile(join(root, "assets", "prompts", "engines", "etl.md"), "etl prompt", "utf8");
  await writeFile(join(root, "assets", "engines", "etl.profile.yaml"), [
    "id: etl",
    "displayName: ETL",
    "protocolVersion: v10",
    "systemPrompt:",
    "  - assets/prompts/shared/vesicle-base.md",
    "  - assets/prompts/engines/etl.md",
    "defaultTools:",
    "  - read_file",
    "  - write_file",
    "validators: []",
    "stopGates: []",
    "stateRoots:",
    "  - source_materials",
    "  - workspace",
    "",
  ].join("\n"), "utf8");
  return root;
}

async function recordSession(root: string, harness: HarnessRuntimeIdentity, options: { pendingGate?: string } = {}): Promise<string> {
  const store = await createSessionStore(root, "sess-migration-e2e");
  await store.append({
    role: "system",
    content: "",
    metadata: { engine: "etl", providerId: "test", model: "test-model", harness },
  });
  await store.append({ role: "user", content: "draft the character card" });
  await store.append({
    role: "assistant",
    content: "",
    metadata: { toolCalls: [{ id: "call-1", name: "write_file", arguments: "{}" }] },
  });
  await store.append({ role: "tool", content: "written", metadata: { toolCallId: "call-1", ok: true } });
  if (options.pendingGate) {
    // The host-produced shape of a turn interrupted on an unanswered gate call.
    await store.append({
      role: "assistant",
      content: "",
      metadata: {
        toolCalls: [{
          id: "gate-1",
          name: "request_confirmation",
          arguments: JSON.stringify({ gate: options.pendingGate, summary: "Review." }),
        }],
      },
    });
  } else {
    await store.append({ role: "user", content: "continue" });
  }
  return store.sessionId;
}

function projectHarness(root: string, harnessIdentity: HarnessRuntimeIdentity): ProjectHarnessRuntime {
  return {
    selection: "bundled",
    lock: {} as ProjectHarnessRuntime["lock"],
    pack: {} as ProjectHarnessRuntime["pack"],
    assets: new AssetResolver(root),
    harness: {
      packId: harnessIdentity.packId,
      packVersion: harnessIdentity.packVersion,
      sourceCommit: harnessIdentity.sourceCommit,
      manifestSha256: harnessIdentity.manifestSha256,
      identity: harnessIdentity,
      driver: undefined as never,
      adapter: undefined as never,
    },
  };
}

function key(name: string): TuiKeyEvent {
  return { name } as TuiKeyEvent;
}

/** The commit runs asynchronously behind the busy panel, like a real keypress. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Wire the real resume + migration controllers together, as app.tsx does. */
function wireControllers(
  root: string,
  harness: ProjectHarnessRuntime,
  resumeAfterMigration?: (target: SessionSummary, commandEcho: string | undefined) => Promise<void>,
) {
  let resume!: (target: SessionSummary, commandEcho?: string) => Promise<void>;
  const errors: unknown[] = [];
  const messages: Message[][] = [];
  const statuses: string[] = [];
  const recordStatus = ((status: string) => { statuses.push(status); }) as never;
  const [migrationReview, setMigrationReview] = createSignal<MigrationReviewState | null>(null);
  const migration = createSessionMigrationController({
    rootDir: root,
    migrationReview,
    setMigrationReview,
    setStatus: recordStatus,
    reportError: (error: unknown) => errors.push(error),
    resumeSession: (target, commandEcho) => resumeAfterMigration
      ? resumeAfterMigration(target, commandEcho)
      : resume(target, commandEcho),
  });
  const noop = () => undefined;
  ({ resumeSession: resume } = createSessionResumeController({
    rootDir: root,
    resolveHarnessRuntime: async () => harness,
    dangerouslySkipPermissions: false,
    permissionSettingsReady: () => true,
    loadPermissionSettings: async () => undefined,
    processManager: { list: async () => [] } as never,
    agentStore: { listByParent: async () => [], listInbox: async () => [] } as never,
    agentCards: () => [],
    setAgentCards: noop,
    permissionMode: () => "MOMENTUM",
    setPermissionMode: noop,
    applyProviderSelection: async (selection: unknown) => selection as never,
    setRestoringSession: noop,
    sessionId: () => undefined,
    setSessionId: noop,
    setNextSessionParent: noop,
    setSessionPath: noop,
    setActiveEngine: noop,
    setConversation: noop,
    setLastTurnUsage: noop,
    setSessionUsage: noop,
    setOutput: noop,
    setSessionPicker: noop,
    setThinkingTier: noop,
    setReasoningDisplayMode: noop,
    setStatus: recordStatus,
    setMessages: (next: unknown) => { messages.push(next as Message[]); },
    setQualityWarnings: noop,
    setQualitySelected: noop,
    setAssetDriftKey: noop,
    refreshArtifacts: async () => undefined,
    reportError: (error: unknown) => errors.push(error),
    setPendingGate: noop,
    setPendingEngineSwitch: noop,
    setPendingUserQuestion: noop,
    setPendingPermission: noop,
    setPendingQualityDecision: noop,
    setGateFocus: noop,
    setGateFeedbackMode: noop,
    setGateFeedback: noop,
    setGateFeedbackCursor: noop,
    setGateFeedbackKillBuffer: noop,
    setQuestionSelected: noop,
    setQuestionFreeformText: noop,
    setQuestionFreeformCursor: noop,
    setQuestionFreeformKillBuffer: noop,
    clearQueuedInputs: noop,
    beginMigrationReview: migration.beginMigrationReview,
  } as never));
  return { resume, migration, migrationReview, errors, messages, statuses };
}

async function archiveFiles(root: string): Promise<string[]> {
  const dir = join(root, ".vesicle", "sessions", "archive");
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

describe("session Harness migration (#239)", () => {
  test("preflight, archive, migrate, and resume under the new baseline end to end", async () => {
    const root = await migrationRoot();
    configureFixtureProvider(root);
    const sessionId = await recordSession(root, baselineA);
    const harness = projectHarness(root, baselineB);
    const livePath = join(root, ".vesicle", "sessions", `${sessionId}.jsonl`);
    const bytesBefore = await readFile(livePath, "utf8");

    // Preflight: clean or warning, never blocking, and never a provider call.
    const report = await runSessionMigrationPreflight({ rootDir: root, sessionId, projectHarness: harness });
    expect(report.verdict).not.toBe("blocking");
    expect(report.from).toEqual(baselineA);
    expect(report.to).toEqual(baselineB);

    // The wired controllers: resume hits the mismatch and opens the review.
    await createRoot(async () => {
      const wired = wireControllers(root, harness);
      const summary: SessionSummary = { sessionId, startedAt: "", updatedAt: "", recordCount: 5, preview: "" };
      await wired.resume(summary);
      expect(wired.errors).toEqual([]);
      const review = wired.migrationReview();
      expect(review?.report.verdict).not.toBe("blocking");
      expect(review?.stage).toBe(1);
      // Session untouched until the two-stage confirmation completes.
      expect(await readFile(livePath, "utf8")).toBe(bytesBefore);

      // Cancel first: Esc leaves the session and the picker state untouched.
      expect(wired.migration.handleMigrationKey(key("escape"))).toBe(true);
      expect(wired.migrationReview()).toBeNull();
      expect(await readFile(livePath, "utf8")).toBe(bytesBefore);

      // Re-enter and confirm twice: stage 1 → 2 → commit → automatic resume.
      await wired.resume(summary);
      expect(wired.migration.handleMigrationKey(key("return"))).toBe(true);
      expect(wired.migrationReview()?.stage).toBe(2);
      expect(wired.migration.handleMigrationKey(key("return"))).toBe(true);
      await waitFor(() => wired.migrationReview() === null);
      await waitFor(() => wired.messages.length > 0);
      expect(wired.errors).toEqual([]);

      // Durable state: archive + migration record + rebinding + warning.
      expect(await archiveFiles(root)).toEqual([`${sessionId}.jsonl`]);
      const archived = await readFile(join(root, ".vesicle", "sessions", "archive", `${sessionId}.jsonl`), "utf8");
      expect(archived.startsWith(bytesBefore)).toBe(true);
      const tagRecord = JSON.parse(archived.split("\n").filter((line) => line.length > 0).at(-1)!) as SessionRecord;
      expect(tagRecord.metadata?.kind).toBe("session-archive");
      expect((tagRecord.metadata as { archive: { to: { packVersion: string } } }).archive.to.packVersion).toBe("10.3.1");

      const snapshot = await loadSessionSnapshot(root, sessionId, { synthesizeDanglingToolResults: false });
      expect(snapshot.harness).toEqual(baselineB);
      const firstRecord = snapshot.records[0]!;
      expect((firstRecord.metadata as { harness: { packVersion: string } }).harness.packVersion).toBe("10.3.0-alpha.2");

      // The resumed transcript carries the durable migration warning.
      const lastMessages = wired.messages.at(-1) ?? [];
      expect(lastMessages.some((message) => message.role === "system" && message.content.includes("now runs under prism-engine-v10@10.3.1"))).toBe(true);

      // A second resume passes the identity check outright: no review, no duplicate archive.
      await wired.resume(summary);
      expect(wired.migrationReview()).toBeNull();
      expect(wired.errors).toEqual([]);
      expect(await archiveFiles(root)).toEqual([`${sessionId}.jsonl`]);

      // listSessions shows exactly the live session.
      const sessions = await listSessions(root);
      expect(sessions.map((entry) => entry.sessionId)).toEqual([sessionId]);
    });

    delete process.env.VESICLE_PROVIDERS_FILE;
  });

  test("a blocking preflight refuses the migration and leaves the session untouched", async () => {
    const root = await migrationRoot();
    configureFixtureProvider(root);
    // A gate paused under "runtime-turn" cannot resolve under the ETL profile,
    // whose stop gates do not declare it.
    const sessionId = await recordSession(root, baselineA, { pendingGate: "runtime-turn" });
    const harness = projectHarness(root, baselineB);
    const livePath = join(root, ".vesicle", "sessions", `${sessionId}.jsonl`);
    const bytesBefore = await readFile(livePath, "utf8");

    const report = await runSessionMigrationPreflight({ rootDir: root, sessionId, projectHarness: harness });
    expect(report.verdict).toBe("blocking");
    expect(report.findings.some((finding) => finding.severity === "blocking" && finding.message.includes("runtime-turn"))).toBe(true);

    await createRoot(async () => {
      const wired = wireControllers(root, harness);
      const summary: SessionSummary = { sessionId, startedAt: "", updatedAt: "", recordCount: 5, preview: "" };
      await wired.resume(summary);
      const review = wired.migrationReview();
      expect(review?.report.verdict).toBe("blocking");
      // Enter on a blocked review closes it; nothing is written.
      expect(wired.migration.handleMigrationKey(key("return"))).toBe(true);
      expect(wired.migrationReview()).toBeNull();
      expect(wired.errors).toEqual([]);
      expect(await readFile(livePath, "utf8")).toBe(bytesBefore);
      expect(await archiveFiles(root)).toEqual([]);
    });

    delete process.env.VESICLE_PROVIDERS_FILE;
  });

  test("keeps the migration surface busy until post-migration resume settles", async () => {
    const root = await migrationRoot();
    configureFixtureProvider(root);
    const sessionId = await recordSession(root, baselineA);
    const harness = projectHarness(root, baselineB);
    let resumeEntered = false;
    let releaseResume!: () => void;
    const resumeAfterMigration = async () => {
      resumeEntered = true;
      await new Promise<void>((resolve) => { releaseResume = resolve; });
    };
    const wired = wireControllers(root, harness, resumeAfterMigration);
    const summary: SessionSummary = { sessionId, startedAt: "", updatedAt: "", recordCount: 5, preview: "" };

    await wired.resume(summary);
    expect(wired.migration.handleMigrationKey(key("return"))).toBe(true);
    expect(wired.migration.handleMigrationKey(key("return"))).toBe(true);
    await waitFor(() => resumeEntered);
    // The panel remains the modal owner while resume restores state.
    expect(wired.migrationReview()?.busy).toBe(true);
    expect(wired.migration.handleMigrationKey(key("return"))).toBe(true);
    expect(wired.migrationReview()?.busy).toBe(true);

    releaseResume();
    await waitFor(() => wired.migrationReview() === null);
    expect(wired.errors).toEqual([]);
  });
});
