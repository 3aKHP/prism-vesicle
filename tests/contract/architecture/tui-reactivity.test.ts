import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "../../../src/core/permissions";
import { resolveBottomSurfaceMode, type BottomSurfaceState } from "../../../src/tui/views/BottomSurface";

/**
 * Static regression guard for the gate-box rendering bug.
 *
 * The original bug: the render body took a non-reactive snapshot
 * `const gate = pendingGate()` and JSX referenced that frozen local, so
 * Solid could not track the signal dependency and the <Show when={gate}>
 * never re-evaluated after the initial render. The gate Select box never
 * appeared even though pendingGate was set. The current code routes both
 * request_confirmation and request_engine_switch through an activeGateRequest
 * memo; this test guards that reactive JSX dependency.
 *
 * OpenTUI's testRender does not reliably replay signal-driven re-renders
 * in this Bun version, so a behavioural test is not feasible. This static
 * guard reads the App source and asserts the reactive-read pattern is used
 * directly in JSX, preventing the snapshot pattern from sneaking back in.
 */
describe("TUI reactivity static guard", () => {
  test("bottom surface receives the reactive active gate accessor directly", async () => {
    const appSource = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "app.tsx"), "utf8");
    const surfaceSource = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "views", "BottomSurface.tsx"), "utf8");

    // The fix reads a reactive memo directly in the JSX when= prop so Solid
    // tracks the dependency and re-renders the Show branch when a gate or
    // engine switch request is set. Assert the positive pattern is present.
    expect(appSource).toContain("gate={gateWithQualityWarning()}");
    expect(appSource).toContain("const gate = activeGateRequest()");
    expect(surfaceSource).toContain("resolveBottomSurfaceMode(props)");

    // And the buggy pattern — Show reading a bare `gate` local captured at
    // render-body scope — must be absent. The status header used to read
    // `gate ?` off the same snapshot; assert both now reference the signal.
    expect(appSource).not.toMatch(/when=\{gate\}/);
    expect(appSource).not.toMatch(/pendingGate\(\) \? palette\.gateAccent : gate \?/);
  });

  test("bottom surface priority is explicit and modal-first", () => {
    const empty: BottomSurfaceState = { yoloStage: null, permissionRequest: undefined, question: null, gate: null, rewind: null, session: null, model: null };
    const rewind = { points: [], selected: 0, restoreSelected: 0, summaryFeedback: "", summaryCursor: 0, busy: false };
    const permission = { toolName: "read_file" } as PermissionRequest;
    expect(resolveBottomSurfaceMode(empty).kind).toBe("composer");
    expect(resolveBottomSurfaceMode({ ...empty, gate: { gate: "phase", summary: "summary", options: [] }, rewind }).kind).toBe("gate");
    expect(resolveBottomSurfaceMode({ ...empty, permissionRequest: permission, rewind }).kind).toBe("permission");
    expect(resolveBottomSurfaceMode({ ...empty, yoloStage: 1, gate: { gate: "phase", summary: "summary", options: [] } }).kind).toBe("yolo");
  });

  test("main layout does not depend on every prompt character", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "app.tsx"), "utf8");
    const layoutBlock = source.match(/const layout = createMemo\(\(\) => resolveTuiLayout\([\s\S]*?\n  \)\);/)?.[0] ?? "";

    expect(layoutBlock).toContain("inputNeedsExpandedBottom()");
    expect(layoutBlock).toContain("Boolean(modelPicker())");
    expect(layoutBlock).not.toContain("inputValue()");
  });

  test("artifact focus closes when the sidebar is no longer visible", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "app.tsx"), "utf8");

    expect(source).toContain("if (focusedArtifactPath() && !layout().showSidebar) setFocusedArtifactPath(null)");
  });

  test("slash-command rows derive selection reactively", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "widgets", "CommandMenu.tsx"), "utf8");

    expect(source).toContain("const isSelected = () => index() === safeSelected()");
    expect(source).not.toMatch(/const isSelected = index === safeSelected\(\)/);
  });

  test("command argument rows derive selection reactively", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "widgets", "ArgumentMenu.tsx"), "utf8");

    expect(source).toContain("const isSelected = () => index() === safeSelected()");
  });

  test("slash-command query changes reset the selected row", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "command-completion-controller.ts"), "utf8");

    expect(source).toContain("const query = commandMenuOpen() ? commandMenuQuery() : null");
    expect(source).toContain("if (query !== previousCommandMenuQuery) setCommandMenuSelected(0)");
  });

  test("Ctrl+Q exits before modal keyboard routing", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "input-routing.ts"), "utf8");
    const ctrlQ = source.indexOf('if (key.ctrl && key.name === "q")');
    const modalRouting = source.indexOf("const mode = bottomSurfaceMode()");

    expect(ctrlQ).toBeGreaterThan(-1);
    expect(modalRouting).toBeGreaterThan(ctrlQ);
  });

  test("input routing shares bottom-surface priority and blocks hidden-composer paste", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "input-routing.ts"), "utf8");
    const modeResolution = source.indexOf("resolveBottomSurfaceMode({");
    const imagePaste = source.indexOf('key.name?.toLowerCase() === "v" && (key.meta || key.option)');
    const composerRouting = source.indexOf("if (options.handleComposerKey(key))");

    expect(modeResolution).toBeGreaterThan(-1);
    expect(source).toContain('if (bottomSurfaceMode().kind !== "composer")');
    expect(imagePaste).toBeGreaterThan(modeResolution);
    expect(composerRouting).toBeGreaterThan(imagePaste);
  });

  test("gate Reject composer owns both keyboard and paste routing", async () => {
    const controller = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "decision-controller.ts"), "utf8");
    const surface = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "views", "BottomSurface.tsx"), "utf8");
    const activeChecks = `${controller}\n${surface}`.match(/gateComposerIsActive\((?:gateFocus\(\), gateFeedbackMode\(\)|props\.gateFocus, props\.gateFeedbackMode)\)/g) ?? [];

    // Keyboard, paste, and gate summary-height budgeting share the predicate.
    expect(activeChecks).toHaveLength(3);
  });

  test("question freeform composer owns both keyboard and paste routing", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "decision-controller.ts"), "utf8");
    const activeChecks = source.match(/questionComposerIsActive\(/g) ?? [];

    expect(activeChecks).toHaveLength(2);
  });

  test("SubAgent lifecycle events do not overwrite the parent STATUS line", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "agent-process-controller.ts"), "utf8");
    const handler = source.match(/function handleAgentLifecycle\(event: AgentLoopEvent\): boolean \{[\s\S]*?\n  \}/)?.[0] ?? "";
    const lifecycleCases = handler.match(/case "agent_created":[\s\S]*?case "agent_completed":/)?.[0] ?? "";

    expect(lifecycleCases).not.toContain("setStatus(");
    expect(source).toContain("setAgentCards((cards) => applyAgentEvent(cards, event))");
    expect(handler).toContain("recordActivity({ kind: \"agent\"");
  });

  test("session restoration blocks background delivery until restored state is coherent", async () => {
    const appSource = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "app.tsx"), "utf8");
    const resumeSource = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "session-resume-controller.ts"), "utf8");

    expect(appSource).toContain("&& !restoringSession()");
    expect(appSource).toContain("const ready = !restoringSession()");
    expect(resumeSource).toMatch(/async function resumeSession[\s\S]*?options\.setRestoringSession\(true\);[\s\S]*?finally \{\n\s+options\.setRestoringSession\(false\);/);
  });

  test("background continuation scheduler is initialized before AgentManager callbacks can use it", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "app.tsx"), "utf8");
    const scheduler = source.indexOf("const continuationScheduler = new AgentContinuationScheduler");
    const manager = source.indexOf("agentManager = new AgentManager");

    expect(scheduler).toBeGreaterThan(-1);
    expect(manager).toBeGreaterThan(scheduler);
    expect(source).not.toContain("let continuationScheduler: AgentContinuationScheduler");
  });

  test("permission submission resolves the same parent-first request that the panel displays", async () => {
    const decisionSource = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "decision-controller.ts"), "utf8");
    expect(decisionSource).toContain("pendingPermission()?.request ?? pendingChildPermission()");
    expect(decisionSource).toContain("if (pendingPermission()) options.submitPermission");
    expect(decisionSource).toContain("else if (pendingChildPermission()) options.submitChildPermission");
  });

  test("permission errors consult durable session state before restoring the modal", async () => {
    const source = await readFile(join(import.meta.dir, "..", "..", "..", "src", "tui", "decision-continuations.ts"), "utf8");
    const handler = source.match(/async function submitPermissionResolution[\s\S]*?function submitChildPermissionResolution/)?.[0] ?? "";
    expect(handler.match(/reconcilePermissionAfterContinuationFailure\(pending\)/g)).toHaveLength(2);
    expect(handler).toContain("loadSessionSnapshot(options.rootDir, pending.sessionId");
    expect(handler).toContain("snapshot.pendingPermission?.id === pending.request.id");
    expect(handler).toContain("setPendingPermission(null)");
  });
});
