/**
 * Human-observation probe for issue #263 (Windows Terminal Working-title
 * horizontal jitter): cycle candidate Working frame sets through the real
 * terminal title (OSC 0) so the host terminal's tab-strip rendering can be
 * judged per candidate.
 *
 * This is evidence tooling, not an automated test: the verdict is a human
 * watching (ideally screen-recording) the tab title while the anchor text
 * after the frame glyph must stay pixel-stable across frame transitions.
 * Run it inside the Windows Terminal window being observed — a WSL session
 * is fine, the tab strip is rendered by Windows Terminal either way. Final
 * #263 acceptance still needs the installed Windows product dogfood.
 *
 * Usage:
 *   bun run scripts/probe/terminal-title-jitter-probe.ts          full roster, cycle mode
 *   bun run scripts/probe/terminal-title-jitter-probe.ts --list   roster only
 *   bun run scripts/probe/terminal-title-jitter-probe.ts --only control-baseline,prism-focus
 *   bun run scripts/probe/terminal-title-jitter-probe.ts --mode step   dwell per frame
 *
 * Options: --mode cycle|step  --interval <ms>  --seconds <n>  --step-seconds <n>
 *          --pause <n>  --only a,b,c  --anchor <text>  --list  --force
 */
import process from "node:process";

type Candidate = {
  name: string;
  frames: string[];
  note: string;
  control?: "negative" | "positive";
};

const DEFAULT_ANCHOR = "▼ 0123456789 ANCHOR · 锚点稳定性";

/**
 * Controls first (they validate the probe itself), then candidates.
 * Roster rule for issue #263: the incumbent Codex (braille) and Claude Code
 * (◐◑) frame sets are deliberately excluded per the product decision.
 */
const CANDIDATES: Candidate[] = [
  {
    name: "control-static",
    frames: ["◈"],
    note: "negative control — single static frame; the anchor must be dead still, or the environment (not the frames) is the noise source",
    control: "negative",
  },
  {
    name: "control-baseline",
    frames: ["◇", "◈", "◆", "◈"],
    note: "positive control — current v1.0.0 frames (U+25C6–C8, already consecutive); must reproduce the known jitter, or the probe is not sensitive enough",
    control: "positive",
  },
  {
    name: "prism-focus",
    frames: ["◇", "◈", "◉", "◊"],
    note: "U+25C7–CA consecutive — diamond family gaining focus; identity-preserving candidate",
  },
  {
    name: "diamond-pair",
    frames: ["◇", "◈"],
    note: "diagnostic subset of the baseline: if control-baseline jitters and this does not, the culprit is ◆ U+25C6 alone and dropping it is the minimal fix",
  },
  {
    name: "square-clock",
    frames: ["◰", "◳", "◲", "◱"],
    note: "U+25F0–F3 consecutive, clockwise sweep (UL→UR→LR→LL) — angular quadrant clock, prism-adjacent",
  },
  {
    name: "materialize",
    frames: ["◌", "◍"],
    note: "U+25CC/CD consecutive — dotted circle → vertically filled: a 'materializing' metaphor for generation",
  },
  {
    name: "moon-wax",
    frames: ["◔", "◑", "◕", "●"],
    note: "U+25D4→D1→D5→CF waxing progression (quarter → half → three-quarter → full); shares the ◑ U+25D1 glyph with the rejected incumbent pair but with different motion — drop via --only if unwanted",
  },
  {
    name: "tide",
    frames: ["◒", "◓"],
    note: "U+25D2/D3 consecutive — vertical halves swapping (lower ↔ upper); structurally a 2-frame alternation like the rejected scheme, different glyphs and metaphor",
  },
  {
    name: "phosphor-fill",
    frames: ["░", "▒", "▓", "█"],
    note: "block elements U+2588/2591–93 — CRT scan fill; strongest CRT-phosphor identity, weakest ink at tab size",
  },
  {
    name: "level-breathe",
    frames: ["▂", "▄", "▆", "█", "▆", "▄"],
    note: "block elements ping-pong — VU-meter breathing, no wrap jump",
  },
  {
    name: "circle-breathe",
    frames: ["○", "◉"],
    note: "U+25CB/C9 — hollow → filled circle",
  },
  {
    name: "arrows",
    frames: ["↺", "↻"],
    note: "U+21BA/BB — 'working/refresh' reads directly, but the Arrows block has no uniform-width guarantee; long shot, included because the probe is cheap",
  },
];

function setTitle(title: string): void {
  process.stdout.write(`\x1b]0;${title}\x07`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFrames(frames: string[]): string {
  return frames
    .map((frame) => `${frame} U+${frame.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" → ");
}

function parseArgs(argv: string[]): {
  mode: "cycle" | "step";
  interval: number;
  seconds: number;
  stepSeconds: number;
  pause: number;
  only: Set<string> | undefined;
  anchor: string;
  list: boolean;
  force: boolean;
} {
  const args = {
    mode: "cycle" as "cycle" | "step",
    interval: 800,
    seconds: 12,
    stepSeconds: 3,
    pause: 3,
    only: undefined as Set<string> | undefined,
    anchor: DEFAULT_ANCHOR,
    list: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--mode":
        if (next === "cycle" || next === "step") args.mode = next;
        else throw new Error("--mode must be cycle or step");
        i += 1;
        break;
      case "--interval":
      case "--seconds":
      case "--step-seconds":
      case "--pause": {
        const value = Number(next);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`${arg} needs a positive number`);
        if (arg === "--interval") args.interval = value;
        else if (arg === "--seconds") args.seconds = value;
        else if (arg === "--step-seconds") args.stepSeconds = value;
        else args.pause = value;
        i += 1;
        break;
      }
      case "--only":
        args.only = new Set(
          next
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean),
        );
        i += 1;
        break;
      case "--anchor":
        args.anchor = next;
        i += 1;
        break;
      case "--list":
        args.list = true;
        break;
      case "--force":
        args.force = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

async function runCandidate(candidate: Candidate, args: { mode: "cycle" | "step"; interval: number; seconds: number; stepSeconds: number; pause: number; anchor: string }): Promise<void> {
  setTitle(`= PAUSE · next: ${candidate.name}`);
  await sleep(args.pause * 1000);
  console.log(`${candidate.control ? `(${candidate.control} control) ` : ""}${candidate.name}`);
  console.log(`  frames: ${describeFrames(candidate.frames)}`);
  console.log(`  ${candidate.note}`);
  if (args.mode === "cycle") {
    console.log(`  cycling ${args.seconds}s @ ${args.interval}ms — watch the ▼ anchor's left edge in the tab title`);
    const deadline = Date.now() + args.seconds * 1000;
    let index = 0;
    while (Date.now() < deadline) {
      const frame = candidate.frames[index % candidate.frames.length];
      setTitle(`${frame} ${args.anchor}`);
      process.stdout.write(`\r  frame ${index + 1}: ${frame} `);
      index += 1;
      await sleep(args.interval);
    }
  } else {
    console.log(`  stepping one frame per ${args.stepSeconds}s — compare the anchor's settled position frame to frame`);
    for (let index = 0; index < candidate.frames.length; index += 1) {
      const frame = candidate.frames[index];
      setTitle(`${frame} ${args.anchor}`);
      process.stdout.write(`\r  frame ${index + 1}/${candidate.frames.length}: ${frame} `);
      await sleep(args.stepSeconds * 1000);
    }
  }
  process.stdout.write("\n\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const candidate of CANDIDATES) {
      console.log(`${candidate.name.padEnd(16)} ${describeFrames(candidate.frames)}`);
      console.log(`${"".padEnd(16)} ${candidate.note}`);
    }
    return 0;
  }
  if (!process.stdout.isTTY && !args.force) {
    console.error("Refusing to run without a TTY: this probe exists to drive the host terminal's title. Re-run inside the terminal being observed, or pass --force.");
    return 1;
  }
  const selected = CANDIDATES.filter((candidate) => !args.only || args.only.has(candidate.name));
  const unknown = args.only ? [...args.only].filter((name) => !CANDIDATES.some((candidate) => candidate.name === name)) : [];
  if (unknown.length > 0) throw new Error(`unknown candidate(s): ${unknown.join(", ")} (see --list)`);
  if (selected.length === 0) throw new Error("no candidates selected");

  console.log("Issue #263 terminal-title frame probe");
  console.log(`  mode=${args.mode} interval=${args.interval}ms anchor="${args.anchor}"`);
  console.log(`  ${selected.length} candidate(s); start a screen recording NOW, review it frame-by-frame afterwards`);
  console.log("  verdict per candidate: stable / jitter / unreadable (glyph too faint or tofu at tab size)");
  console.log("  also judge: does the motion read as 'working', and does it sit well next to idle '·' and input-required '!'?");
  console.log("");

  let cancelled = false;
  const onInterrupt = (): void => {
    cancelled = true;
  };
  process.on("SIGINT", onInterrupt);
  try {
    for (const candidate of selected) {
      if (cancelled) break;
      await runCandidate(candidate, args);
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    setTitle(cancelled ? "probe cancelled · #263" : "probe done · #263");
  }
  if (cancelled) return 130;

  console.log("Results template (fill in while reviewing the recording):");
  for (const candidate of selected) {
    console.log(`  ${candidate.name.padEnd(16)} ______  notes:`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
