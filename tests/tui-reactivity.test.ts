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
 * appeared even though pendingGate was set.
 *
 * OpenTUI's testRender does not reliably replay signal-driven re-renders
 * in this Bun version, so a behavioural test is not feasible. This static
 * guard reads the App source and asserts the reactive-read pattern is used
 * directly in JSX, preventing the snapshot pattern from sneaking back in.
 */
describe("TUI reactivity static guard", () => {
  test("Show reads pendingGate() directly in JSX (not via a frozen local)", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "tui", "app.tsx"), "utf8");

    // The fix reads the signal directly in the JSX when= prop so Solid
    // tracks the dependency and re-renders the Show branch when the gate
    // is set. Assert the positive pattern is present.
    expect(source).toMatch(/when=\{pendingGate\(\)\}/);

    // And the buggy pattern — Show reading a bare `gate` local captured at
    // render-body scope — must be absent. The status header used to read
    // `gate ?` off the same snapshot; assert both now reference the signal.
    expect(source).not.toMatch(/when=\{gate\}/);
    expect(source).not.toMatch(/pendingGate\(\) \? palette\.gateAccent : gate \?/);
  });
});
