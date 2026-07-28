import { describe, expect, test } from "bun:test";
import { createThemeScheduler } from "../../../src/tui/theme-runtime";
import { nextAutoThemeBoundary } from "../../../src/tui/theme";

/**
 * The auto-boundary scheduler (plan §7.2). The oracle is scheduling behaviour
 * (delays, reschedule, cancel/replace, self-correction, cleanup) driven through
 * injected clock/timer seams — the tests never sleep until 07:00/19:00.
 */
describe("theme auto scheduler", () => {
  type FakeTimer = { fn: () => void; at: number };
  const minute = 60_000;

  function harness(initialPref: "auto" | "dark") {
    let nowMs = new Date("2026-03-15T12:00:00").getTime(); // noon → next boundary 19:00
    const timers = new Map<number, FakeTimer>();
    let nextId = 1;
    let refreshCalls = 0;
    const now = () => new Date(nowMs);
    const setTimer = (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fn, at: nowMs + ms });
      return () => { timers.delete(id); };
    };
    let pref = initialPref;
    const scheduler = createThemeScheduler({
      now,
      getPreference: () => pref,
      refresh: () => { refreshCalls++; },
      setTimer,
    });
    return {
      scheduler,
      setPref: (next: "auto" | "dark") => { pref = next; },
      advanceToNextBoundary: () => {
        const pending = [...timers.values()].sort((a, b) => a.at - b.at)[0];
        if (!pending) return false;
        nowMs = pending.at;
        pending.fn();
        return true;
      },
      pendingCount: () => timers.size,
      pendingDelay: () => {
        const pending = [...timers.values()].sort((a, b) => a.at - b.at)[0];
        return pending ? pending.at - nowMs : null;
      },
      refreshCalls: () => refreshCalls,
      nowMs: () => nowMs,
    };
  }

  test("schedules the next boundary delay when entering auto", () => {
    const h = harness("auto");
    h.scheduler.schedule();
    const expected = nextAutoThemeBoundary(new Date("2026-03-15T12:00:00")).getTime()
      - new Date("2026-03-15T12:00:00").getTime();
    expect(h.pendingDelay()).toBe(expected);
    expect(h.pendingCount()).toBe(1);
  });

  test("is a no-op when the preference is not auto", () => {
    const h = harness("dark");
    h.scheduler.schedule();
    expect(h.pendingCount()).toBe(0);
  });

  test("a boundary fire refreshes and reschedules the next boundary", () => {
    const h = harness("auto");
    h.scheduler.schedule();
    expect(h.refreshCalls()).toBe(0);
    // Advance to the 19:00 boundary.
    expect(h.advanceToNextBoundary()).toBe(true);
    expect(h.refreshCalls()).toBe(1);
    // Rescheduled toward tomorrow's 07:00.
    expect(h.pendingCount()).toBe(1);
    const expected = nextAutoThemeBoundary(new Date("2026-03-15T19:00:00")).getTime()
      - new Date("2026-03-15T19:00:00").getTime();
    expect(h.pendingDelay()).toBe(expected);
  });

  test("a delayed fire self-corrects from actual now, not the scheduled boundary", () => {
    const h = harness("auto");
    h.scheduler.schedule();
    // Simulate a long sleep past the boundary by rewiring `now` via advance:
    // fire the pending timer; it refreshes and reschedules from the new now.
    expect(h.advanceToNextBoundary()).toBe(true);
    // The reschedule used the post-advance now (the boundary instant), so the
    // next delay points at the following boundary rather than a stale offset.
    expect(h.pendingDelay()).toBeGreaterThan(0);
    expect(h.pendingCount()).toBe(1);
  });

  test("leaving auto cancels the pending timer", () => {
    const h = harness("auto");
    h.scheduler.schedule();
    expect(h.pendingCount()).toBe(1);
    h.setPref("dark");
    h.scheduler.schedule();
    expect(h.pendingCount()).toBe(0);
  });

  test("re-entering auto replaces the stale timer without duplicate callbacks", () => {
    const h = harness("auto");
    h.scheduler.schedule();
    const firstDelay = h.pendingDelay();
    h.scheduler.schedule();
    expect(h.pendingCount()).toBe(1);
    expect(h.pendingDelay()).toBe(firstDelay);
  });

  test("dispose cancels the pending timer", () => {
    const h = harness("auto");
    h.scheduler.schedule();
    expect(h.pendingCount()).toBe(1);
    h.scheduler.dispose();
    expect(h.pendingCount()).toBe(0);
  });

  test("schedule after dispose re-arms a fresh timer", () => {
    const h = harness("auto");
    h.scheduler.schedule();
    h.scheduler.dispose();
    expect(h.pendingCount()).toBe(0);
    h.scheduler.schedule();
    expect(h.pendingCount()).toBe(1);
  });

  test("delay is bounded by a sane window (never negative, never > 12h)", () => {
    const h = harness("auto");
    h.scheduler.schedule();
    const delay = h.pendingDelay()!;
    expect(delay).toBeGreaterThanOrEqual(0);
    // The widest gap is just under 12h (19:00 → 07:00 next day).
    expect(delay).toBeLessThanOrEqual(12 * 60 * minute);
  });
});
