import { describe, expect, test } from "bun:test";
import { testRender } from "@3akhp/opentui-solid";
import { createRoot, createSignal } from "solid-js";
import { MigrationPrompt, migrationIdentityLine, migrationPanelHeight } from "../../../src/tui/MigrationPrompt";
import type { MigrationReviewState } from "../../../src/tui/session-migration-controller";
import { createSessionMigrationController } from "../../../src/tui/session-migration-controller";
import { resolveBottomSurfaceMode } from "../../../src/tui/views/BottomSurface";
import type { SessionSummary } from "../../../src/core/session/store";
import type { SessionMigrationPreflightReport } from "../../../src/core/agent-loop/session-migration-preflight";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";

function summary(): SessionSummary {
  return { sessionId: "2026-08-24T00-00-00-000Z-abcd1234", startedAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T01:00:00Z", recordCount: 4, preview: "hello" };
}

function report(overrides: Partial<SessionMigrationPreflightReport> = {}): SessionMigrationPreflightReport {
  return {
    sessionId: "s",
    engine: "etl",
    from: {
      packId: "prism-engine-v10", packVersion: "10.3.0-alpha.1", sourceCommit: "c", manifestSha256: "a".repeat(64),
      adapterId: "vesicle-v1", adapterVersion: "1.1.0", adapterHash: "b".repeat(64),
    },
    to: {
      packId: "prism-engine-v10", packVersion: "10.3.0-alpha.2", sourceCommit: "d", manifestSha256: "e".repeat(64),
      adapterId: "vesicle-v1", adapterVersion: "1.1.0", adapterHash: "f".repeat(64),
    },
    findings: [],
    verdict: "clean",
    ...overrides,
  };
}

function state(overrides: Partial<MigrationReviewState> = {}): MigrationReviewState {
  return { stage: 1, focused: "confirm", target: summary(), report: report(), busy: false, ...overrides };
}

function key(name: string): TuiKeyEvent {
  return { name } as TuiKeyEvent;
}

describe("tui: session migration prompt", () => {
  test("renders the stage-1 review with identity line and confirm options", async () => {
    const current = state({ report: report({ verdict: "warning", findings: [{ severity: "warning", layer: "resume", message: "Skill \"novel-outline-v3\" no longer resolves under the current installation and will leave the catalog." }] }) });
    const setup = await testRender(() => <MigrationPrompt state={current} width={100} />, { width: 100, height: migrationPanelHeight(current, 100) });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("DANGER · Migrate session Harness baseline (1/2)");
    expect(frame).toContain(migrationIdentityLine(current));
    expect(frame).toContain("⚠ Skill");
    expect(frame).toContain("Continue");
    expect(frame).toContain("Cancel");
    expect(frame).toContain("Esc cancel");
  });

  test("a blocking verdict refuses the migration and offers no confirm option", async () => {
    const current = state({ report: report({ verdict: "blocking", findings: [{ severity: "blocking", layer: "resume", message: "Engine \"weaver\" is not available under the new baseline." }] }) });
    const setup = await testRender(() => <MigrationPrompt state={current} width={100} />, { width: 100, height: migrationPanelHeight(current, 100) });
    await setup.flush();
    const frame = setup.captureCharFrame();
    setup.renderer.destroy();
    expect(frame).toContain("BLOCKED · Session Harness migration");
    expect(frame).toContain("✗ Engine");
    expect(frame).toContain("migration is refused");
    expect(frame).toContain("Esc close");
    expect(frame).not.toContain("→ Continue");
  });
});

describe("tui: session migration keyboard flow", () => {
  function harness(initial: MigrationReviewState) {
    let status = "";
    const errors: unknown[] = [];
    const [migrationReview, setMigrationReview] = createSignal<MigrationReviewState | null>(initial);
    const controller = createSessionMigrationController({
      rootDir: "/nonexistent",
      migrationReview,
      setMigrationReview,
      setStatus: (next) => { status = next as string; },
      reportError: (error) => errors.push(error),
      resumeSession: async () => undefined,
    });
    return { migrationReview, setMigrationReview, controller, status: () => status, errors };
  }

  test("Enter advances stage 1 to 2 and Esc cancels without touching the session", () => {
    createRoot(() => {
      const { migrationReview, controller, status } = harness(state());
      expect(controller.handleMigrationKey(key("return"))).toBe(true);
      expect(migrationReview()?.stage).toBe(2);
      expect(controller.handleMigrationKey(key("escape"))).toBe(true);
      expect(migrationReview()).toBeNull();
      expect(status()).toContain("session unchanged");
    });
  });

  test("up/down toggles focus and reject+Enter cancels", () => {
    createRoot(() => {
      const { migrationReview, controller } = harness(state());
      controller.handleMigrationKey(key("down"));
      expect(migrationReview()?.focused).toBe("reject");
      controller.handleMigrationKey(key("up"));
      expect(migrationReview()?.focused).toBe("confirm");
      controller.handleMigrationKey(key("down"));
      expect(controller.handleMigrationKey(key("return"))).toBe(true);
      expect(migrationReview()).toBeNull();
    });
  });

  test("a blocking verdict closes on Enter instead of confirming", () => {
    createRoot(() => {
      const { migrationReview, controller } = harness(state({ report: report({ verdict: "blocking", findings: [{ severity: "blocking", layer: "invariant", message: "broken pairing" }] }) }));
      expect(controller.handleMigrationKey(key("return"))).toBe(true);
      expect(migrationReview()).toBeNull();
    });
  });

  test("the busy commit window swallows keys", () => {
    createRoot(() => {
      const { migrationReview, controller } = harness(state({ stage: 2, busy: true }));
      expect(controller.handleMigrationKey(key("return"))).toBe(true);
      expect(controller.handleMigrationKey(key("escape"))).toBe(true);
      expect(migrationReview()?.busy).toBe(true);
    });
  });
});

describe("tui: migration review outranks the session picker", () => {
  test("resolveBottomSurfaceMode prefers the migration review over an open picker", () => {
    const mode = resolveBottomSurfaceMode({
      yoloStage: null,
      migrationReview: state(),
      session: { sessions: [], selected: 0 },
      question: null,
      gate: null,
      rewind: null,
      branch: null,
      skillPicker: null,
      model: null,
    });
    expect(mode.kind).toBe("session-migration");
  });
});
