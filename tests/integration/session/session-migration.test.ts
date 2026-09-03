import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot, createSignal } from "solid-js";
import { AssetResolver } from "../../../src/core/runtime/assets";
import { createSessionStore, listSessions, loadSessionRecords, loadSessionSnapshot } from "../../../src/core/session/store";
import type { SessionRecord } from "../../../src/core/session/record-model";
import type { SessionSummary } from "../../../src/core/session/store";
import type { ProjectHarnessRuntime } from "../../../src/core/harness/activation";
import type { HarnessRuntimeIdentity } from "../../../src/core/harness/driver";
import { createSessionResumeController } from "../../../src/tui/session-resume-controller";
import { createSessionMigrationController } from "../../../src/tui/session-migration-controller";
import type { MigrationReviewState } from "../../../src/tui/session-migration-controller";
import { runSessionMigrationPreflight } from "../../../src/core/agent-loop/session-migration-preflight";
import { configureFixtureProvider } from "../harness/fixtures/harness";
import {
  activateSkillForSession,
  clearSessionActivations,
  clearSessionSkillCatalog,
  resolveSkillCatalog,
  snapshotSkillCatalog,
  SKILL_ACTIVATION_KIND,
} from "../../../src/core/skills";
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

const baselineA = identity("10.3.2", "a".repeat(64), "1.2.0");
const baselineB = identity("10.3.3", "c".repeat(64), "1.2.0");

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
      expect((tagRecord.metadata as { archive: { to: { packVersion: string } } }).archive.to.packVersion).toBe(baselineB.packVersion);

      const snapshot = await loadSessionSnapshot(root, sessionId, { synthesizeDanglingToolResults: false });
      expect(snapshot.harness).toEqual(baselineB);
      const firstRecord = snapshot.records[0]!;
      expect((firstRecord.metadata as { harness: { packVersion: string } }).harness.packVersion).toBe(baselineA.packVersion);

      // The resumed transcript carries the durable migration warning.
      const lastMessages = wired.messages.at(-1) ?? [];
      expect(lastMessages.some((message) => message.role === "system" && message.content.includes(`now runs under prism-engine-v10@${baselineB.packVersion}`))).toBe(true);

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

  // #298: the migration re-freezes the Skill catalog at the current
  // installation's content and re-activation works again for a changed host
  // Skill whose pre-migration activation went stale.
  test("re-freezes the Skill catalog at migration and lets a changed host Skill be activated again", async () => {
    const root = await migrationRoot();
    configureFixtureProvider(root);
    const hostAssets = join(root, "host-assets");
    const skillRoot = join(hostAssets, "skills", "docs-like");
    await mkdir(skillRoot, { recursive: true });
    const writeBody = async (body: string) => {
      await writeFile(join(skillRoot, "SKILL.md"), `---\nname: docs-like\ndescription: docs-like description\n---\n\n${body}\n`, "utf8");
    };
    const env = (): NodeJS.ProcessEnv => ({ ...process.env, VESICLE_HOST_ASSETS_DIR: hostAssets });
    const previousHostAssets = process.env.VESICLE_HOST_ASSETS_DIR;
    process.env.VESICLE_HOST_ASSETS_DIR = hostAssets;
    try {
      await writeBody("# docs-like\n\nProcedure body v1.");
      const sessionId = "sess-skill-refreeze-e2e";

      // Record the pre-migration session: header freezes the v1 catalog, a
      // host activation record pins docs-like at the v1 hash.
      const v1Snapshot = snapshotSkillCatalog(await resolveSkillCatalog(root, env(), { id: "etl" }));
      expect(v1Snapshot.entries.map((entry) => entry.name)).toEqual(["docs-like"]);
      const v1Hash = v1Snapshot.entries[0]!.bodySha256;
      const store = await createSessionStore(root, sessionId);
      await store.append({
        role: "system",
        content: "",
        metadata: { engine: "etl", providerId: "test", model: "test-model", harness: baselineA, skills: v1Snapshot },
      });
      const preMigrationUser = await store.append({
        role: "user",
        content: `[skill_activation name="docs-like" scope="host" hash="${v1Hash}" status="activated"]\nv1 body\n[/skill_activation]`,
        metadata: { kind: SKILL_ACTIVATION_KIND, name: "docs-like", scope: "host", contentHash: v1Hash, mode: "invoke", scripts: [] },
      });
      await store.append({ role: "assistant", content: "used the docs", metadata: { engine: "etl", model: "test-model" } });

      // The host installation moves on: the Skill body changes underneath.
      await writeBody("# docs-like\n\nProcedure body v2 with the read-only mount note.");

      const harness = projectHarness(root, baselineB);
      const report = await runSessionMigrationPreflight({ rootDir: root, sessionId, projectHarness: harness });
      expect(report.verdict).not.toBe("blocking");
      expect(report.findings.some((finding) => finding.severity === "warning" && finding.message.includes("docs-like") && finding.message.includes("must be activated again"))).toBe(true);
      expect(report.skillRefreeze?.reactivate).toEqual(["docs-like"]);
      const v2Hash = report.skillRefreeze!.snapshot.entries.find((entry) => entry.name === "docs-like")!.bodySha256;
      expect(v2Hash).not.toBe(v1Hash);

      // Two-stage confirmation commit through the real controllers.
      await createRoot(async () => {
        const wired = wireControllers(root, harness);
        const summary: SessionSummary = { sessionId, startedAt: "", updatedAt: "", recordCount: 4, preview: "" };
        await wired.resume(summary);
        expect(wired.migration.handleMigrationKey(key("return"))).toBe(true);
        expect(wired.migration.handleMigrationKey(key("return"))).toBe(true);
        await waitFor(() => wired.migrationReview() === null);
        expect(wired.errors).toEqual([]);

        // The migration record carries the re-freeze; the header keeps its
        // append-only v1 bytes.
        const records = await loadSessionRecords(root, sessionId);
        const migrationRecord = records.find((record) => record.metadata?.kind === "session-migration")!;
        expect((migrationRecord.metadata as { skills?: { entries?: { name: string; bodySha256: string }[] } }).skills?.entries?.find((entry) => entry.name === "docs-like")?.bodySha256).toBe(v2Hash);
        const headerMetadata = records[0]!.metadata as { skills?: { entries?: { name: string; bodySha256: string }[] } };
        expect(headerMetadata.skills?.entries?.find((entry) => entry.name === "docs-like")?.bodySha256).toBe(v1Hash);

        // The re-freeze is session-level: the default head and a fork truncated
        // before the migration record both resolve the v2 snapshot (#298 I2).
        const active = await loadSessionSnapshot(root, sessionId, { synthesizeDanglingToolResults: false });
        expect(active.skillCatalogSnapshot?.entries.find((entry) => entry.name === "docs-like")?.bodySha256).toBe(v2Hash);
        const forked = await loadSessionSnapshot(root, sessionId, { headUuid: preMigrationUser.uuid, synthesizeDanglingToolResults: false });
        expect(forked.skillCatalogSnapshot?.entries.find((entry) => entry.name === "docs-like")?.bodySha256).toBe(v2Hash);
        expect(forked.harness).toEqual(baselineB);

        // Re-activation works again, at the new content hash, without dedup
        // suppressing it — and settles into alreadyActive on the second call.
        const first = await activateSkillForSession(root, env(), sessionId, "docs-like", { profile: { id: "etl" } });
        expect(first.alreadyActive).toBe(false);
        expect(first.contentHash).toBe(v2Hash);
        expect(typeof first.recordUuid).toBe("string");
        const second = await activateSkillForSession(root, env(), sessionId, "docs-like", { profile: { id: "etl" } });
        expect(second.alreadyActive).toBe(true);
        expect(second.contentHash).toBe(v2Hash);
      });
    } finally {
      clearSessionSkillCatalog("sess-skill-refreeze-e2e");
      clearSessionActivations("sess-skill-refreeze-e2e");
      if (previousHostAssets === undefined) delete process.env.VESICLE_HOST_ASSETS_DIR;
      else process.env.VESICLE_HOST_ASSETS_DIR = previousHostAssets;
      delete process.env.VESICLE_PROVIDERS_FILE;
    }
  });

  // Review finding: a legacy snapshot-less session fresh-freezes on any
  // resume, so Skills joining the catalog are not a migration consequence for
  // it; only sessions that actually froze a catalog may report the join.
  test("a legacy session without a frozen catalog reports no spurious join warning", async () => {
    const root = await migrationRoot();
    configureFixtureProvider(root);
    const hostAssets = join(root, "host-assets");
    const writeHostSkill = async (name: string) => {
      const skillRoot = join(hostAssets, "skills", name);
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n\nProcedure body.\n`, "utf8");
    };
    await writeHostSkill("alpha");
    // Freeze while only "alpha" exists, then add "beta" to the installation.
    const alphaSnapshot = snapshotSkillCatalog(await resolveSkillCatalog(root, { ...process.env, VESICLE_HOST_ASSETS_DIR: hostAssets }, { id: "etl" }));
    expect(alphaSnapshot.entries.map((entry) => entry.name)).toEqual(["alpha"]);
    await writeHostSkill("beta");
    const previousHostAssets = process.env.VESICLE_HOST_ASSETS_DIR;
    process.env.VESICLE_HOST_ASSETS_DIR = hostAssets;
    try {
      const sessionId = "sess-legacy-no-snapshot";
      const store = await createSessionStore(root, sessionId);
      await store.append({ role: "system", content: "", metadata: { engine: "etl", providerId: "test", model: "test-model", harness: baselineA } });
      await store.append({ role: "user", content: "hello" });
      await store.append({ role: "assistant", content: "reply", metadata: { engine: "etl", model: "test-model" } });

      const harness = projectHarness(root, baselineB);
      const report = await runSessionMigrationPreflight({ rootDir: root, sessionId, projectHarness: harness });
      expect(report.verdict).toBe("clean");
      expect(report.findings.some((finding) => finding.message.includes("will join it"))).toBe(false);

      // Positive control: the same host catalog reported against a session
      // that froze only "alpha" does surface the join as a migration finding.
      const frozenSession = "sess-frozen-alpha";
      const frozen = await createSessionStore(root, frozenSession);
      await frozen.append({
        role: "system",
        content: "",
        metadata: { engine: "etl", providerId: "test", model: "test-model", harness: baselineA, skills: alphaSnapshot },
      });
      await frozen.append({ role: "user", content: "hello" });
      await frozen.append({ role: "assistant", content: "reply", metadata: { engine: "etl", model: "test-model" } });
      const frozenReport = await runSessionMigrationPreflight({ rootDir: root, sessionId: frozenSession, projectHarness: harness });
      expect(frozenReport.verdict).toBe("warning");
      expect(frozenReport.findings.some((finding) => finding.message.includes("1 Skill(s) not in the frozen catalog will join it: beta"))).toBe(true);
    } finally {
      if (previousHostAssets === undefined) delete process.env.VESICLE_HOST_ASSETS_DIR;
      else process.env.VESICLE_HOST_ASSETS_DIR = previousHostAssets;
      delete process.env.VESICLE_PROVIDERS_FILE;
    }
  });
});

// #308: a Skill body that drifted without a Harness identity change is the
// non-migration drift case — resume must surface an actionable hint pointing
// at the explicit re-freeze command, without writing anything.
describe("session Skill catalog drift hint (#308)", () => {
  test("resume with unchanged identity shows the drift hint and appends nothing", async () => {
    const root = await migrationRoot();
    configureFixtureProvider(root);
    const hostAssets = join(root, "host-assets");
    const skillRoot = join(hostAssets, "skills", "docs-like");
    await mkdir(skillRoot, { recursive: true });
    const writeBody = async (body: string) => {
      await writeFile(join(skillRoot, "SKILL.md"), `---\nname: docs-like\ndescription: docs-like description\n---\n\n${body}\n`, "utf8");
    };
    await writeBody("# docs-like\n\nProcedure body v1.");
    const v1Snapshot = snapshotSkillCatalog(
      await resolveSkillCatalog(root, { ...process.env, VESICLE_HOST_ASSETS_DIR: hostAssets }, { id: "etl" }),
    );
    const sessionId = "sess-skill-drift-hint";
    const store = await createSessionStore(root, sessionId);
    await store.append({
      role: "system",
      content: "",
      metadata: { engine: "etl", providerId: "test", model: "test-model", harness: baselineA, skills: v1Snapshot },
    });
    await store.append({ role: "user", content: "hello" });
    await store.append({ role: "assistant", content: "reply", metadata: { engine: "etl", model: "test-model" } });
    const recordCount = (await loadSessionRecords(root, sessionId)).length;

    // The installation moves on without any Harness identity change.
    await writeBody("# docs-like\n\nProcedure body v2.");
    const previousHostAssets = process.env.VESICLE_HOST_ASSETS_DIR;
    process.env.VESICLE_HOST_ASSETS_DIR = hostAssets;
    try {
      await createRoot(async () => {
        // Same identity on both sides: no migration review, only the hint.
        const wired = wireControllers(root, projectHarness(root, baselineA));
        const summary: SessionSummary = { sessionId, startedAt: "", updatedAt: "", recordCount: 3, preview: "" };
        await wired.resume(summary);
        expect(wired.errors).toEqual([]);
        expect(wired.migrationReview()).toBeNull();
        const transcript = wired.messages.at(-1) ?? [];
        const driftNotice = transcript.find((message) => message.content.includes("Skill catalog drift detected"));
        expect(driftNotice?.content).toContain("1 changed, 0 removed, 0 added");
        expect(driftNotice?.content).toContain("/skill refresh");
        expect(driftNotice?.content).toContain("must be activated again");
        // Advisory only: nothing was appended to the durable session.
        expect(await loadSessionRecords(root, sessionId)).toHaveLength(recordCount);
      });
    } finally {
      clearSessionSkillCatalog(sessionId);
      if (previousHostAssets === undefined) delete process.env.VESICLE_HOST_ASSETS_DIR;
      else process.env.VESICLE_HOST_ASSETS_DIR = previousHostAssets;
      delete process.env.VESICLE_PROVIDERS_FILE;
    }
  });

  test("resume stays silent without drift and for a legacy snapshot-less session", async () => {
    const root = await migrationRoot();
    configureFixtureProvider(root);
    const hostAssets = join(root, "host-assets");
    const skillRoot = join(hostAssets, "skills", "docs-like");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: docs-like\ndescription: docs-like description\n---\n\n# docs-like\n\nProcedure body.\n",
      "utf8",
    );
    const snapshot = snapshotSkillCatalog(
      await resolveSkillCatalog(root, { ...process.env, VESICLE_HOST_ASSETS_DIR: hostAssets }, { id: "etl" }),
    );
    const frozenSession = "sess-skill-drift-silent";
    const frozen = await createSessionStore(root, frozenSession);
    await frozen.append({
      role: "system",
      content: "",
      metadata: { engine: "etl", providerId: "test", model: "test-model", harness: baselineA, skills: snapshot },
    });
    await frozen.append({ role: "user", content: "hello" });
    // A legacy session that never froze a catalog: additions are ordinary
    // resume behavior for it, not drift (#307 lesson).
    const legacySession = "sess-skill-drift-legacy";
    const legacy = await createSessionStore(root, legacySession);
    await legacy.append({
      role: "system",
      content: "",
      metadata: { engine: "etl", providerId: "test", model: "test-model", harness: baselineA },
    });
    await legacy.append({ role: "user", content: "hello" });

    const previousHostAssets = process.env.VESICLE_HOST_ASSETS_DIR;
    process.env.VESICLE_HOST_ASSETS_DIR = hostAssets;
    try {
      await createRoot(async () => {
        const wired = wireControllers(root, projectHarness(root, baselineA));
        const resumeSession = async (sessionId: string) => {
          const summary: SessionSummary = { sessionId, startedAt: "", updatedAt: "", recordCount: 2, preview: "" };
          await wired.resume(summary);
          expect(wired.errors).toEqual([]);
          const transcript = wired.messages.at(-1) ?? [];
          expect(transcript.some((message) => message.content.includes("Skill catalog drift detected"))).toBe(false);
        };
        // The frozen catalog matches the installation exactly: no drift.
        await resumeSession(frozenSession);

        // Then the installation grows "beta": the frozen session would now
        // drift, but the legacy snapshot-less session must stay silent —
        // additions are ordinary resume behavior for it (#307 lesson).
        const betaRoot = join(hostAssets, "skills", "beta");
        await mkdir(betaRoot, { recursive: true });
        await writeFile(
          join(betaRoot, "SKILL.md"),
          "---\nname: beta\ndescription: beta description\n---\n\n# beta\n\nProcedure body.\n",
          "utf8",
        );
        await resumeSession(legacySession);
      });
    } finally {
      clearSessionSkillCatalog(frozenSession);
      clearSessionSkillCatalog(legacySession);
      if (previousHostAssets === undefined) delete process.env.VESICLE_HOST_ASSETS_DIR;
      else process.env.VESICLE_HOST_ASSETS_DIR = previousHostAssets;
      delete process.env.VESICLE_PROVIDERS_FILE;
    }
  });
});
