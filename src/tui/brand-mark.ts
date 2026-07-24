/**
 * ANSI-derived snapshots of the Prism Vesicle brand mark, consumed by the
 * startup splash (M1) and the empty-session hero (M2).
 *
 * These constants are copied verbatim from `brand/prism-vesicle.ascii.txt`
 * (trailing whitespace stripped), which is itself derived from the primary
 * brand renders in `brand/` via the luminance ramp " .:-=+*#%@". In-app marks
 * may only ever be ANSI-derived — OpenTUI does not emit raster protocols, so
 * bitmaps cannot be inlined in the terminal. When the primary visual changes,
 * re-derive the ASCII file and refresh these snapshots in the same pass.
 */

export const PRIMARY_MARK: readonly string[] = [
  "                      ..:------:..",
  "                  .-====--------====-.",
  "               .-==:.            .:-==-.",
  "              -+=:.                  .:=+-",
  "            :+=:                        :=+:",
  "           .+-.                          .-+.",
  "           +-.             ..             .-+",
  "          -+.             .==.             .+-",
  "          -+.            :=..=:            .-+",
  "          +:            :=....-:            :+.",
  "        .-#=.          -- .    ::           -+",
  "    ...:+@@#===-======#=-----::.=#         .==",
  "         .-*-.       -.      ....=-        :+.",
  "           :+:      =:........    .=      :+:",
  "            :+-.                        .-+:",
  "              ==-.                    .-==",
  "               .==-:.              .:-==.",
  "                  :-==--::....::--===:",
  "                     .:--=======-:.",
];

export const COMPACT_MARK: readonly string[] = [
  "        :-====-:",
  "     .+**=----=**+.",
  "    -%+.        .+%-",
  "   :@-     ..     -@:",
  "   *#     .##.     #*",
  "   ::    :%@@%:    #+",
  "    #+  .******.  .:.",
  "    .*#-.      .-#=",
  "      :+**++++**+:",
  "         .::::.",
];

/**
 * Density-ramp tinting from the brand ANSI layer: `%#@` toward bright emerald
 * (beam core / rim hot spots), `=+*` toward deep emerald, `.:-` toward the
 * dark surface family for a faint halo. All values come from the locked
 * palette in `dev/docs/working/PRISM_VESICLE_VISUAL_LANGUAGE.md` §4.
 */
const CELL_COLORS: Record<string, string> = {
  "@": "#34d399",
  "#": "#10b981",
  "%": "#10b981",
  "=": "#047857",
  "+": "#047857",
  "*": "#047857",
  ":": "#1c211e",
  "-": "#1c211e",
  ".": "#1c211e",
};

export type MarkRun = { text: string; fg?: string };

/**
 * Run-length encode a mark into colored spans per row. Runs without an fg are
 * plain background cells (spaces). Row content and order are preserved, so
 * concatenating a row's runs reproduces the source line.
 */
export function markRuns(mark: readonly string[]): MarkRun[][] {
  return mark.map((line) => {
    const runs: MarkRun[] = [];
    for (const char of line) {
      const fg = CELL_COLORS[char];
      const last = runs[runs.length - 1];
      if (last && last.fg === fg) {
        last.text += char;
      } else {
        runs.push({ text: char, ...(fg ? { fg } : {}) });
      }
    }
    return runs;
  });
}

/** Multiply a #rrggbb color by a brightness factor; used for splash fade-out. */
export function scaleHex(hex: string, factor: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number) =>
    Math.round(((value >> shift) & 0xff) * Math.max(0, Math.min(1, factor)));
  const scaled = (channel(16) << 16) | (channel(8) << 8) | channel(0);
  return `#${scaled.toString(16).padStart(6, "0")}`;
}

/** Apply a brightness factor to every colored run (uncolored runs unchanged). */
export function fadedRuns(runs: MarkRun[][], factor: number): MarkRun[][] {
  if (factor >= 1) return runs;
  return runs.map((row) =>
    row.map((run) => (run.fg ? { ...run, fg: scaleHex(run.fg, factor) } : run))
  );
}

export type SplashMode = "animated" | "static" | "frozen" | "skip";

/**
 * Degradation ladder for the startup splash (visual contract §4):
 *   - non-interactive terminal           → skip (in and out, never blocks)
 *   - reduced motion requested           → frozen single frame, light stopped
 *   - no truecolour (256-colour or less) → static quantized frame, no motion
 *   - otherwise                          → full glow + traveling light
 *
 * `reducedMotion` is the terminal stand-in for `prefers-reduced-motion`;
 * callers source it from the `VESICLE_REDUCED_MOTION=1` environment variable.
 */
export function resolveSplashMode(options: {
  isTty: boolean;
  rgb: boolean;
  reducedMotion: boolean;
}): SplashMode {
  if (!options.isTty) return "skip";
  if (options.reducedMotion) return "frozen";
  if (!options.rgb) return "static";
  return "animated";
}
