import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

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
  test("Show reads activeGateRequest() directly in JSX (not via a frozen local)", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");

    // The fix reads a reactive memo directly in the JSX when= prop so Solid
    // tracks the dependency and re-renders the Show branch when a gate or
    // engine switch request is set. Assert the positive pattern is present.
    expect(source).toMatch(/when=\{activeGateRequest\(\)\}/);

    // And the buggy pattern — Show reading a bare `gate` local captured at
    // render-body scope — must be absent. The status header used to read
    // `gate ?` off the same snapshot; assert both now reference the signal.
    expect(source).not.toMatch(/when=\{gate\}/);
    expect(source).not.toMatch(/pendingGate\(\) \? palette\.gateAccent : gate \?/);
  });

  test("main layout does not depend on every prompt character", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");
    const layoutBlock = source.match(/const layout = createMemo\(\(\) => resolveTuiLayout\([\s\S]*?\n  \)\);/)?.[0] ?? "";

    expect(layoutBlock).toContain("inputNeedsExpandedBottom()");
    expect(layoutBlock).toContain("Boolean(modelPicker())");
    expect(layoutBlock).not.toContain("inputValue()");
  });

  test("slash-command rows derive selection reactively", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "widgets", "CommandMenu.tsx"), "utf8");

    expect(source).toContain("const isSelected = () => index() === safeSelected()");
    expect(source).not.toMatch(/const isSelected = index === safeSelected\(\)/);
  });

  test("command argument rows derive selection reactively", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "widgets", "ArgumentMenu.tsx"), "utf8");

    expect(source).toContain("const isSelected = () => index() === safeSelected()");
  });

  test("slash-command query changes reset the selected row", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");

    expect(source).toContain("const query = commandMenuOpen() ? commandMenuQuery() : null");
    expect(source).toContain("if (query !== previousCommandMenuQuery) setCommandMenuSelected(0)");
  });

  test("Ctrl+Q exits before modal keyboard routing", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");
    const ctrlQ = source.indexOf('if (key.ctrl && key.name === "q")');
    const modelPickerRouting = source.indexOf("if (modelPicker())");

    expect(ctrlQ).toBeGreaterThan(-1);
    expect(modelPickerRouting).toBeGreaterThan(ctrlQ);
  });

  test("image paste is owned by the main composer after modal routing", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");
    const gateRouting = source.indexOf("if (pendingGate() || pendingEngineSwitch())");
    const imagePaste = source.indexOf('key.name?.toLowerCase() === "v" && (key.meta || key.option)');
    const composerRouting = source.indexOf("if (handleComposerKey(key))");

    expect(imagePaste).toBeGreaterThan(gateRouting);
    expect(composerRouting).toBeGreaterThan(imagePaste);
  });

  test("gate Reject composer owns both keyboard and paste routing", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");
    const activeChecks = source.match(/gateComposerIsActive\(gateFocus\(\), gateFeedbackMode\(\)\)/g) ?? [];

    // Keyboard, paste, and gate summary-height budgeting share the predicate.
    expect(activeChecks).toHaveLength(3);
  });

  test("question freeform composer owns both keyboard and paste routing", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");
    const activeChecks = source.match(/questionComposerIsActive\(/g) ?? [];

    expect(activeChecks).toHaveLength(2);
  });

  test("SubAgent lifecycle events do not overwrite the parent STATUS line", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");
    const handler = source.match(/function handleAgentEvent\(event: AgentLoopEvent\) \{[\s\S]*?\n  \}\n\n  function recordActivity/)?.[0] ?? "";
    const lifecycleCases = handler.match(/case "agent_created":[\s\S]*?case "agent_completed":/)?.[0] ?? "";

    expect(lifecycleCases).not.toContain("setStatus(");
    expect(handler).toContain("setAgentCards((cards) => applyAgentEvent(cards, event))");
    expect(handler).toContain("recordActivity({ kind: \"agent\"");
  });

  test("session restoration blocks background delivery until restored state is coherent", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");

    expect(source).toContain("&& !restoringSession()");
    expect(source).toContain("const ready = !restoringSession()");
    expect(source).toMatch(/async function resumeSession[\s\S]*?setRestoringSession\(true\);[\s\S]*?finally \{\n\s+setRestoringSession\(false\);/);
  });

  test("background continuation scheduler is initialized before AgentManager callbacks can use it", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");
    const scheduler = source.indexOf("const continuationScheduler = new AgentContinuationScheduler");
    const manager = source.indexOf("const agentManager = new AgentManager");

    expect(scheduler).toBeGreaterThan(-1);
    expect(manager).toBeGreaterThan(scheduler);
    expect(source).not.toContain("let continuationScheduler: AgentContinuationScheduler");
  });

  test("permission submission resolves the same parent-first request that the panel displays", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");
    expect(source).toContain("pendingPermission()?.request ?? pendingChildPermission()");
    expect(source.match(/if \(pendingPermission\(\)\) \{[\s\S]*?submitPermissionResolution/g)).toHaveLength(2);
  });

  test("permission errors consult durable session state before restoring the modal", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");
    const handler = source.match(/const submitPermissionResolution[\s\S]*?function submitChildPermissionResolution/)?.[0] ?? "";
    expect(handler.match(/reconcilePermissionAfterContinuationFailure\(pending\)/g)).toHaveLength(2);
    expect(handler).toContain("loadSessionSnapshot(process.cwd(), pending.sessionId");
    expect(handler).toContain("snapshot.pendingPermission?.id === pending.request.id");
    expect(handler).toContain("setPendingPermission(null)");
  });
});
