import { Readable, Writable } from "node:stream";
import {
  CliRenderer,
  destroyTreeSitterClient,
  getTreeSitterClient,
  MarkdownRenderable,
  parseColor,
} from "@opentui/core";
import type { SimpleHighlight } from "@opentui/core";
import { installMarkdownEscapeConceal } from "./markdown-escape-conceal";
import { paletteFor, syntaxStyle } from "./theme";

// The escape-conceal transform must be active in every channel this
// diagnostic runs at (source, npm, binaries, installer smoke).
installMarkdownEscapeConceal();

declare const VESICLE_TREE_SITTER_WORKER_PATH: string;

type RuntimeProbe = {
  filetype: "markdown" | "typescript";
  error?: string;
  warning?: string;
  highlights: { count: number; groups: string[] };
};

export type MarkdownRuntimeDiagnostic = {
  ok: boolean;
  workerPath?: string;
  probes: RuntimeProbe[];
  escape: {
    ok: boolean;
    concealedCount: number;
    error?: string;
  };
  selection: {
    ok: boolean;
    cases: SelectionRuntimeProbe[];
  };
};

type SelectionRuntimeProbe = {
  name: "prose" | "list" | "link" | "fenced-code" | "table-cell";
  ok: boolean;
  selectedText?: string;
  error?: string;
};

const SELECTION_PROBES: Array<{
  name: SelectionRuntimeProbe["name"];
  content: string;
  needle: string;
}> = [
  { name: "prose", content: "prose alpha", needle: "alpha" },
  { name: "list", content: "- list beta", needle: "beta" },
  { name: "link", content: "[link epsilon](https://example.com)", needle: "epsilon" },
  { name: "fenced-code", content: "```ts\ncode gamma\n```", needle: "gamma" },
  {
    name: "table-cell",
    content: "| Head | Value |\n| --- | --- |\n| row | table delta |",
    needle: "delta",
  },
];

/**
 * Verify the worker, web-tree-sitter runtime, bundled grammars, and fixed
 * highlight inputs without starting the interactive TUI or reading user data.
 */
export async function runMarkdownRuntimeDiagnostic(): Promise<MarkdownRuntimeDiagnostic> {
  try {
    const [probes, escapeProbe, selectionCases] = await Promise.all([
      Promise.all([
        probe("markdown", "**bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |"),
        probe("typescript", "const value: number = 1;"),
      ]),
      probeEscapeConceal(),
      Promise.all(SELECTION_PROBES.map(probeNativeMarkdownSelection)),
    ]);
    const selection = {
      ok: selectionCases.every((entry) => entry.ok),
      cases: selectionCases,
    };
    return {
      ok: probes.every((entry) => !entry.error && entry.highlights.count > 0) && escapeProbe.ok && selection.ok,
      workerPath: typeof VESICLE_TREE_SITTER_WORKER_PATH !== "undefined"
        ? VESICLE_TREE_SITTER_WORKER_PATH
        : process.env.OTUI_TREE_SITTER_WORKER_PATH,
      probes,
      escape: escapeProbe,
      selection,
    };
  } finally {
    // The diagnostic is a short-lived CLI operation. Leaving OpenTUI's worker
    // alive keeps Bun's event loop open and makes CI smoke commands hang.
    await destroyTreeSitterClient().catch(() => undefined);
  }
}

/**
 * Distribution-boundary oracle for the interim backslash-escape fix: the
 * highlight tuples of `Escaped \~ and \* here` must conceal exactly the two
 * backslash bytes, so a channel that lost the transform (or a future
 * dependency bump that changes the shape) fails the smoke instead of
 * silently regressing to literal escape rendering.
 */
async function probeEscapeConceal(): Promise<MarkdownRuntimeDiagnostic["escape"]> {
  const content = "Escaped \\~ and \\* here";
  try {
    const result = await getTreeSitterClient().highlightOnce(content, "markdown");
    const highlights: SimpleHighlight[] | undefined = result.highlights;
    if (!highlights?.length) throw new Error("markdown highlighting produced no highlights");
    const concealed = highlights.filter(
      (highlight) => highlight[2] === "string.escape" && highlight[3]?.conceal === "",
    );
    const backslashBytes = [8, 15];
    const coversOnlyBackslashes = concealed.length === backslashBytes.length
      && backslashBytes.every((offset) => concealed.some((highlight) => highlight[0] === offset && highlight[1] === offset + 1));
    if (!coversOnlyBackslashes) {
      throw new Error(
        `expected backslash-byte conceals at ${backslashBytes.join(", ")}; got ${JSON.stringify(concealed)}`,
      );
    }
    return { ok: true, concealedCount: concealed.length };
  } catch (error) {
    return { ok: false, concealedCount: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

class DiagnosticWriteStream extends Writable {
  readonly isTTY = true;
  readonly columns = 60;
  readonly rows = 10;

  override _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback();
  }

  getColorDepth(): number {
    return 24;
  }
}

async function probeNativeMarkdownSelection(
  scenario: (typeof SELECTION_PROBES)[number],
): Promise<SelectionRuntimeProbe> {
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  const renderer = new CliRenderer(
    stdin,
    new DiagnosticWriteStream() as unknown as NodeJS.WriteStream,
    60,
    10,
    {
      bufferedOutput: "memory",
      consoleMode: "disabled",
      screenMode: "main-screen",
      useThread: false,
    },
  );
  const light = paletteFor("light");
  const markdown = new MarkdownRenderable(renderer, {
    content: scenario.content,
    syntaxStyle: syntaxStyle(),
    selectionBg: light.selectionBackground,
    selectionFg: light.selectionForeground,
  });
  renderer.root.add(markdown);

  try {
    const point = await renderUntilNeedle(renderer, scenario.needle);
    emitMouseDrag(stdin, point.x, point.y, point.x + scenario.needle.length, point.y);
    await renderOnce(renderer);

    const expectedForeground = parseColor(light.selectionForeground).toInts();
    const expectedBackground = parseColor(light.selectionBackground).toInts();
    const selectedSpans = renderer.currentRenderBuffer.getSpanLines()
      .flatMap((line) => line.spans)
      .filter((span) => colorsEqual(span.bg.toInts(), expectedBackground));
    if (selectedSpans.length === 0) throw new Error("selection background was not painted");
    if (selectedSpans.some((span) => !colorsEqual(span.fg.toInts(), expectedForeground))) {
      throw new Error("selection foreground was not painted uniformly");
    }
    const selectedText = renderer.getSelection()?.getSelectedText();
    if (!selectedText?.includes(scenario.needle)) {
      throw new Error(`selected text did not contain ${JSON.stringify(scenario.needle)}`);
    }
    return { name: scenario.name, ok: true, selectedText };
  } catch (error) {
    return {
      name: scenario.name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    renderer.destroy();
  }
}

async function renderUntilNeedle(
  renderer: CliRenderer,
  needle: string,
): Promise<{ x: number; y: number }> {
  const decoder = new TextDecoder();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await renderOnce(renderer);
    const frame = decoder.decode(renderer.currentRenderBuffer.getRealCharBytes(true));
    const lines = frame.split("\n");
    for (let y = 0; y < lines.length; y += 1) {
      const x = lines[y]!.indexOf(needle);
      if (x >= 0) return { x, y };
    }
    await Bun.sleep(10);
  }
  throw new Error(`rendered frame did not contain ${JSON.stringify(needle)}`);
}

async function renderOnce(renderer: CliRenderer): Promise<void> {
  // Importing OpenTUI's testing entry here would bundle a second core. Drive
  // the linked renderer so installed-package diagnostics exercise the TUI copy.
  await (renderer as unknown as { loop: () => Promise<void> }).loop();
}

function emitMouseDrag(
  stdin: NodeJS.ReadStream,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): void {
  stdin.emit("data", Buffer.from(`\x1b[<0;${startX + 1};${startY + 1}M`));
  stdin.emit("data", Buffer.from(`\x1b[<32;${endX + 1};${endY + 1}m`));
  stdin.emit("data", Buffer.from(`\x1b[<0;${endX + 1};${endY + 1}m`));
}

function colorsEqual(actual: number[], expected: number[]): boolean {
  return actual.every((value, index) => value === expected[index]);
}

async function probe(filetype: RuntimeProbe["filetype"], content: string): Promise<RuntimeProbe> {
  try {
    const result = await getTreeSitterClient().highlightOnce(content, filetype);
    return {
      filetype,
      error: result.error,
      warning: result.warning,
      highlights: summarizeHighlights(result.highlights),
    };
  } catch (error) {
    return {
      filetype,
      error: error instanceof Error ? error.message : String(error),
      highlights: { count: 0, groups: [] },
    };
  }
}

function summarizeHighlights(highlights: SimpleHighlight[] | undefined): { count: number; groups: string[] } {
  const groups = new Set<string>();
  for (const highlight of highlights ?? []) {
    if (groups.size >= 8) break;
    groups.add(highlight[2]);
  }
  return { count: highlights?.length ?? 0, groups: Array.from(groups) };
}
