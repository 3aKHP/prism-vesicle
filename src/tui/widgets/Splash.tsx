import { createEffect, createSignal, onCleanup, onMount, Show, type Accessor } from "solid-js";
import { COMPACT_MARK, PRIMARY_MARK, scaleHex, type SplashMode } from "../brand-mark";
import { palette } from "../theme";
import { BrandMark } from "./BrandMark";

/**
 * M1 — startup splash (visual contract §2): the ANSI prism-vesicle mark plus
 * the PRISM VESICLE wordmark, with a single traveling light orbiting the
 * membrane — the only continuous motion allowed here. It never blocks startup:
 * the first frame is drawable immediately, dismissal is driven by provider
 * readiness plus a small dwell budget, and any keypress ends it at once.
 * Degradation (contract §4) is decided by `resolveSplashMode` in the caller;
 * this component only honours the resulting mode.
 */

const MIN_DWELL_MS = 800;
const MAX_DWELL_MS = 3000;
const FADE_STEPS = [0.55, 0.22] as const;
const FADE_STEP_MS = 110;
const ORBIT_MS = 12_000;
const LIGHT_TICK_MS = 80;

/** Approximate membrane ellipse per mark, in mark-local cells. */
const ORBITS: Record<string, { cx: number; cy: number; rx: number; ry: number }> = {
  primary: { cx: 28, cy: 9, rx: 18, ry: 8 },
  compact: { cx: 12, cy: 4.5, rx: 8, ry: 4 },
};

const LIGHT_COLOR = "#34d399";
const WORDMARK_COLOR = "#10b981";

export function Splash(props: {
  mode: Exclude<SplashMode, "skip">;
  ready: Accessor<boolean>;
  forceDone: Accessor<boolean>;
  width: number;
  height: number;
  onGone: () => void;
}) {
  const [fadeFactor, setFadeFactor] = createSignal(1);
  // Frozen mode parks the light partway along the membrane so even the still
  // frame reads as "the light is alive" (visual language §2).
  const [lightT, setLightT] = createSignal(props.mode === "frozen" ? 0.15 : 0);

  const mark = () => (props.width >= 64 && props.height >= 26 ? PRIMARY_MARK : COMPACT_MARK);
  const orbit = () => (mark() === PRIMARY_MARK ? ORBITS.primary : ORBITS.compact)!;
  const markWidth = () => Math.max(...mark().map((line) => line.length));
  const contentHeight = () => mark().length + 1 + 2;
  const originX = () => Math.max(0, Math.floor((props.width - markWidth()) / 2));
  const originY = () => Math.max(0, Math.floor((props.height - contentHeight()) / 2));

  const lightCell = () => {
    const { cx, cy, rx, ry } = orbit();
    const angle = lightT() * Math.PI * 2;
    return {
      col: Math.round(cx + rx * Math.cos(angle)),
      row: Math.round(cy + ry * Math.sin(angle)),
    };
  };

  let gone = false;
  let fading = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    timers.add(timer);
    return timer;
  };
  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  function finish(): void {
    if (gone) return;
    gone = true;
    clearTimers();
    props.onGone();
  }

  function startFade(): void {
    if (gone || fading) return;
    fading = true;
    // Static / frozen frames skip the fade entirely — stepped dimming is the
    // only transition the animated mode spends, and steps easing keeps it
    // inside the motion grammar.
    if (props.mode !== "animated") {
      finish();
      return;
    }
    let step = 0;
    const tick = () => {
      if (step >= FADE_STEPS.length) {
        finish();
        return;
      }
      setFadeFactor(FADE_STEPS[step]!);
      step += 1;
      later(tick, FADE_STEP_MS);
    };
    tick();
  }

  const mountedAt = Date.now();

  onMount(() => {
    later(startFade, MAX_DWELL_MS);
    if (props.mode === "animated") {
      const interval = setInterval(() => {
        setLightT((t) => (t + LIGHT_TICK_MS / ORBIT_MS) % 1);
      }, LIGHT_TICK_MS);
      onCleanup(() => clearInterval(interval));
    }
  });

  createEffect(() => {
    if (!props.ready()) return;
    later(startFade, Math.max(0, MIN_DWELL_MS - (Date.now() - mountedAt)));
  });

  createEffect(() => {
    if (props.forceDone()) finish();
  });

  onCleanup(clearTimers);

  return (
    <box position="absolute" left={0} top={0} width="100%" height="100%" backgroundColor={palette.bg}>
      <box
        position="absolute"
        left={originX()}
        top={originY()}
        width={markWidth()}
        height={contentHeight()}
        flexDirection="column"
        alignItems="center"
      >
        <BrandMark mark={mark()} fade={fadeFactor()} />
        <box height={1} />
        <Show
          when={props.width >= 56}
          fallback={<text content="PRISM VESICLE" fg={scaleHex(WORDMARK_COLOR, fadeFactor())} attributes={1} wrapMode="none" />}
        >
          <ascii_font text="PRISM VESICLE" font="tiny" color={scaleHex(WORDMARK_COLOR, fadeFactor())} />
        </Show>
        <Show when={props.mode !== "static"} fallback={<box width={0} height={0} />}>
          <text
            position="absolute"
            left={lightCell().col}
            top={lightCell().row}
            content="@"
            fg={scaleHex(LIGHT_COLOR, fadeFactor())}
            attributes={1}
            wrapMode="none"
          />
        </Show>
      </box>
    </box>
  );
}
