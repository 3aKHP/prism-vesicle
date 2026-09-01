/**
 * Human-observation probe for issue #268 item 7 (terminal-title idle `·` and
 * input-required `!` markers read too light next to the ◰◳◲◱ working frames).
 *
 * Section 1 shows each candidate marker as a STATIC title so its ink weight and
 * readability at tab-strip size can be judged on its own. Section 2 rotates
 * each full three-state scheme (working frame → idle marker → input marker) at
 * a slow dwell so the family coherence of the triplet can be judged.
 *
 * This is evidence tooling, not an automated test: the verdict is a human
 * watching the Windows Terminal tab strip. Run it inside the window being
 * observed — a WSL session is fine, the tab strip is rendered by Windows
 * Terminal either way.
 *
 * Usage:
 *   bun run scripts/probe/terminal-title-marker-probe.ts           full roster
 *   bun run scripts/probe/terminal-title-marker-probe.ts --list    roster only
 *   bun run scripts/probe/terminal-title-marker-probe.ts --only idle-dot,scheme-bracket
 *
 * Options: --seconds <n>  --only a,b,c  --anchor <text>  --list  --force
 */
import process from "node:process";

type MarkerCandidate = {
  name: string;
  kind: "marker" | "scheme";
  /** marker: [marker]; scheme: [working, idle, input] */
  frames: string[];
  note: string;
};

const DEFAULT_ANCHOR = "▼ 0123456789 ANCHOR · 锚点稳定性";
const WORKING_FRAME = "◰"; // U+25F0, first of the shipped working set

const CANDIDATES: MarkerCandidate[] = [
  // Section 1 — static markers (incumbents first as controls).
  {
    name: "idle-incumbent",
    kind: "marker",
    frames: ["·"],
    note: "control — current idle marker U+00B7 MIDDLE DOT; the weight complaint baseline",
  },
  {
    name: "idle-dot",
    kind: "marker",
    frames: ["●"],
    note: "U+25CF BLACK CIRCLE — same geometric-shapes block as the ◰ working frames; option (a) from the issue",
  },
  {
    name: "idle-square",
    kind: "marker",
    frames: ["■"],
    note: "U+25A0 BLACK SQUARE — strongest ink of the single-glyph options; matches the working frames' square silhouette",
  },
  {
    name: "idle-small-square",
    kind: "marker",
    frames: ["▪"],
    note: "U+25AA BLACK SMALL SQUARE — lighter than ■; check whether it still reads at tab size",
  },
  {
    name: "input-incumbent",
    kind: "marker",
    frames: ["!"],
    note: "control — current input-required marker U+0021; the weight complaint baseline",
  },
  {
    name: "input-bracket",
    kind: "marker",
    frames: ["[!]"],
    note: "option (b) from the issue — 3 columns wide vs 1 for every single glyph; watch the anchor shift right",
  },
  {
    name: "input-square",
    kind: "marker",
    frames: ["▣"],
    note: "U+25A3 WHITE SQUARE CONTAINING BLACK SMALL SQUARE — 'attention' reading inside the square family",
  },
  // Section 2 — three-state schemes (working → idle → input, slow rotation).
  {
    name: "scheme-incumbent",
    kind: "scheme",
    frames: [WORKING_FRAME, "·", "!"],
    note: "control — shipped triplet; judge how much lighter · and ! sit against ◰",
  },
  {
    name: "scheme-dot",
    kind: "scheme",
    frames: [WORKING_FRAME, "●", "!"],
    note: "option (a) — only idle gains weight",
  },
  {
    name: "scheme-bracket",
    kind: "scheme",
    frames: [WORKING_FRAME, "●", "[!]"],
    note: "option (b) — both static states gain weight; input state costs 2 extra columns",
  },
  {
    name: "scheme-blocks",
    kind: "scheme",
    frames: [WORKING_FRAME, "■", "▣"],
    note: "option (c) — unified square family across all three states, all 1 column",
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
    .map((frame) => {
      const points = Array.from(frame)
        .map((char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
        .join(" ");
      return `${frame} ${points}`;
    })
    .join(" → ");
}

type ProbeArgs = {
  seconds: number;
  only: Set<string> | undefined;
  anchor: string;
  list: boolean;
  force: boolean;
};

function parseArgs(argv: string[]): ProbeArgs {
  const args: ProbeArgs = { seconds: 4, only: undefined, anchor: DEFAULT_ANCHOR, list: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--seconds": {
        const value = Number(next);
        if (!Number.isFinite(value) || value <= 0) throw new Error("--seconds needs a positive number");
        args.seconds = value;
        i += 1;
        break;
      }
      case "--only":
        if (next === undefined) throw new Error("--only requires a comma-separated candidate list");
        args.only = new Set(next.split(",").map((name) => name.trim()).filter(Boolean));
        i += 1;
        break;
      case "--anchor":
        if (next === undefined) throw new Error("--anchor requires a text value");
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

async function runCandidate(candidate: MarkerCandidate, args: ProbeArgs, shouldCancel: () => boolean): Promise<void> {
  console.log(`${candidate.name}`);
  console.log(`  ${candidate.kind}: ${describeFrames(candidate.frames)}`);
  console.log(`  ${candidate.note}`);
  if (candidate.kind === "marker") {
    console.log(`  static for ${args.seconds}s — judge ink weight and readability at tab size`);
    setTitle(`${candidate.frames[0]} ${args.anchor}`);
    await sleep(args.seconds * 1000);
  } else {
    const labels = ["working", "idle", "input-required"];
    console.log(`  rotating working → idle → input, ${args.seconds}s per state — judge family coherence`);
    for (let index = 0; index < candidate.frames.length; index += 1) {
      if (shouldCancel()) break;
      setTitle(`${candidate.frames[index]} ${args.anchor}`);
      process.stdout.write(`\r  showing: ${labels[index]} (${candidate.frames[index]}) `);
      await sleep(args.seconds * 1000);
    }
    process.stdout.write("\n");
  }
  console.log("");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const candidate of CANDIDATES) {
      console.log(`${candidate.name.padEnd(20)} ${candidate.kind.padEnd(6)} ${describeFrames(candidate.frames)}`);
      console.log(`${"".padEnd(20)} ${candidate.note}`);
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

  console.log("Issue #268 item 7 terminal-title marker probe");
  console.log(`  dwell=${args.seconds}s anchor="${args.anchor}"`);
  console.log(`  ${selected.length} candidate(s); start a screen recording NOW, review it afterwards`);
  console.log("  verdict per marker: readable / too faint / tofu; per scheme: coherent / mismatched");
  console.log("");

  let cancelled = false;
  const onInterrupt = (): void => {
    cancelled = true;
  };
  process.on("SIGINT", onInterrupt);
  try {
    for (const candidate of selected) {
      if (cancelled) break;
      await runCandidate(candidate, args, () => cancelled);
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    setTitle(cancelled ? "probe cancelled · #268-7" : "probe done · #268-7");
  }
  if (cancelled) return 130;

  console.log("Results template (fill in while reviewing the recording):");
  for (const candidate of selected) {
    console.log(`  ${candidate.name.padEnd(20)} ______  notes:`);
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
