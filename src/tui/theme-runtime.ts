import {
  nextAutoThemeBoundary,
  refreshAutoTheme,
  themePreference,
  type ThemePreference,
} from "./theme";

/**
 * One owner for the `auto` time-boundary timer over the active renderer
 * lifecycle. The preference domain and reactive palette authority stay in
 * `theme.ts`; this module owns only scheduling.
 *
 * Contract (plan §7.2):
 *   1. Entering effective `auto` resolves immediately and schedules the next
 *      boundary (next local 07:00 or 19:00 strictly after `now`).
 *   2. A boundary callback re-resolves from the actual current time and
 *      schedules a new boundary, so a delayed fire after sleep self-corrects.
 *   3. Leaving `auto` cancels the existing timer.
 *   4. Re-entering `auto` cancels any stale timer before scheduling.
 *   5. `dispose()` cancels the timer cleanly.
 *
 * `schedule()` is idempotent: calling it again clears any prior timer first.
 * The caller drives it from a reactive effect on the effective preference so
 * source changes (session override, /new, resume) re-evaluate it. Tests inject
 * `now`/`getPreference`/`setTimer`/`refresh` so they never sleep until 07:00.
 */

export type ThemeSchedulerOptions = {
  /** Clock seam; defaults to the real wall clock. */
  now?: () => Date;
  /** Preference reader seam; defaults to the live reactive signal. */
  getPreference?: () => ThemePreference;
  /** Refresh seam; defaults to the live `refreshAutoTheme`. */
  refresh?: () => void;
  /**
   * Timer seam: schedule `fn` after `ms` and return a cancel function. Defaults
   * to the real `setTimeout`/`clearTimeout` pair.
   */
  setTimer?: (fn: () => void, ms: number) => () => void;
};

export type ThemeScheduler = {
  /**
   * Cancel any pending timer and, if the effective preference is `auto`,
   * schedule the next boundary. No-op for every other preference.
   */
  schedule: () => void;
  /** Cancel the pending timer. Safe to call multiple times. */
  dispose: () => void;
};

function defaultSetTimer(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

export function createThemeScheduler(options: ThemeSchedulerOptions = {}): ThemeScheduler {
  const now = options.now ?? (() => new Date());
  const getPreference = options.getPreference ?? themePreference;
  const refresh = options.refresh ?? refreshAutoTheme;
  const setTimer = options.setTimer ?? defaultSetTimer;
  let cancel: (() => void) | null = null;

  function clear(): void {
    if (cancel) {
      const stop = cancel;
      cancel = null;
      stop();
    }
  }

  function schedule(): void {
    clear();
    if (getPreference() !== "auto") return;
    const current = now();
    const delay = Math.max(0, nextAutoThemeBoundary(current).getTime() - current.getTime());
    cancel = setTimer(() => {
      refresh();
      schedule();
    }, delay);
  }

  return { schedule, dispose: clear };
}
