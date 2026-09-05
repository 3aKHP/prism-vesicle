import { expect, test } from "bun:test";
import { testRender } from "@3akhp/opentui-solid";
import { TextAttributes, type TextareaRenderable } from "@3akhp/opentui-core";
import { createMemo, createSignal, Show } from "solid-js";
import { BottomSurface } from "../../src/tui/views/BottomSurface";
import { ReadingOverlay } from "../../src/tui/reading/ReadingView";
import { createReadingController } from "../../src/tui/reading/controller";
import { projectReadingSurface } from "../../src/tui/reading/surfaces";
import { readingModes, readingOptions, readingPanelProps } from "./reading-fixtures";
import { configureTreeSitterWorkerPath } from "../../src/tui/tree-sitter-runtime";
import { captureFrameUntil } from "./markdown-frame";

configureTreeSitterWorkerPath();

test("expanded gate renders one title and Markdown emphasis, lists, tables and code", async () => {
  const mode = { kind: "gate" as const, gate: { gate: "blueprint", summary: [
    "## Blueprint", "", "**Important** and *emphasis*", "", "- Parent", "  - Nested", "",
    "| Name | Value |", "| --- | --- |", "| Rock | Hard |", "", "```", "literal **code**", "```",
  ].join("\n") } };
  let reader!: ReturnType<typeof createReadingController>;
  const setup = await testRender(() => {
    reader = createReadingController({
      document: () => projectReadingSurface(mode, { ...readingOptions, height: 8 }),
      liveKinds: () => ["gate"], width: () => 80, height: () => 30,
    });
    return <ReadingOverlay controller={reader} width={80} height={30} />;
  }, { width: 80, height: 34 });
  try {
    reader.handleKey({ name: "tab" });
    const frame = await captureFrameUntil(setup, (frame) => frame.includes("Important") && !frame.includes("**Important**"));
    expect(frame.match(/Stop Gate: blueprint/g)?.length).toBe(1);
    expect(frame).toContain("Important");
    expect(frame).not.toContain("**Important**");
    expect(frame).not.toContain("*emphasis*");
    expect(frame).not.toContain("| --- | --- |");
    expect(frame).toContain("Nested");
    expect(frame).toContain("literal **code**");
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.some((span) => span.text.includes("Important") && Boolean(span.attributes & TextAttributes.BOLD))).toBe(true);
  } finally { setup.renderer.destroy(); }
});

test("Markdown question reading wraps long titles and preserves its text anchor across resize and return", async () => {
  const questionMode = readingModes.find((mode) => mode.kind === "question")!;
  const header = `${"Long question title ".repeat(8)}TITLE-END`;
  const mode = { ...questionMode, pending: { ...questionMode.pending, question: {
    ...questionMode.pending.question, header,
    question: Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n**ANCHOR-${i}** ${"中文 text ".repeat(30)}\n`).join("\n"),
    options: [{ label: "Choose", description: "**OPTION-TAIL**", kind: "model" as const }],
  } } };
  const [width, setWidth] = createSignal(80);
  const [height, setHeight] = createSignal(20);
  let reader!: ReturnType<typeof createReadingController>;
  const setup = await testRender(() => {
    reader = createReadingController({
      document: () => projectReadingSurface(mode, { ...readingOptions, width: width(), height: 8 }),
      liveKinds: () => ["question"], width, height,
    });
    return <Show when={reader.expanded()}><ReadingOverlay controller={reader} width={width()} height={height()} /></Show>;
  }, { width: 80, height: 24 });
  try {
    reader.handleKey({ name: "tab" });
    const initial = await captureFrameUntil(setup, (frame) => frame.includes("ANCHOR-0") && !frame.includes("**ANCHOR-0**"));
    expect(initial).toContain("TITLE-END");
    expect(initial.match(/TITLE-END/g)?.length).toBe(1);
    for (let i = 0; i < 40; i += 1) reader.handleKey({ name: "down" });
    await setup.flush();
    const before = setup.captureCharFrame();
    const anchor = before.match(/ANCHOR-\d+/)?.[0];
    expect(anchor).toBeDefined();
    for (const [columns, lines] of [[44, 16], [120, 36], [80, 20]]) {
      setWidth(columns!); setHeight(lines!); setup.resize(columns!, lines! + 4);
      await setup.flush();
      expect(setup.captureCharFrame()).toContain(anchor!);
    }
    reader.handleKey({ name: "end" });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("OPTION-TAIL");
    expect(setup.captureCharFrame()).not.toContain("**OPTION-TAIL**");
    const atEnd = reader.start();
    reader.handleKey({ name: "enter" });
    await setup.flush();
    expect(reader.active()).toBe(false);
    reader.handleKey({ name: "tab" });
    await captureFrameUntil(setup, (frame) => frame.includes("OPTION-TAIL") && !frame.includes("**OPTION-TAIL**"));
    expect(setup.captureCharFrame()).toContain("OPTION-TAIL");
    expect(reader.start()).toBe(atEnd);
    reader.handleKey({ name: "home" });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("TITLE-END");
  } finally { setup.renderer.destroy(); }
});

const controls: Record<string, string[]> = {
  permission: ["Allow once", "Reject", "Esc reject"], gate: ["Confirm", "Reject"],
  question: ["Choice 0", "Answer freely"], quality: ["Revision unavailable", "Stop"],
  yolo: ["Enable YOLO for this process", "Cancel", "Esc cancel"],
  "quality-rewrite-confirm": ["Enable Review and Rewrite", "Cancel", "Esc cancel"],
  "session-migration": ["Continue", "Cancel", "Esc cancel"],
  rewind: ["Restore code and conversation", "Never mind", "Esc back"],
  branch: ["Never mind", "Esc back"], session: ["Enter resume"],
  model: ["Enter select"], "skill-picker": ["Enter activate"], "quality-picker": ["Enter select"],
};

for (const [width, height] of [[80, 24], [120, 40], [80, 16]]) {
  test(`all compact panels keep controls at ${width}x${height}`, async () => {
    for (const mode of readingModes) {
      const props = readingPanelProps(mode, width, Math.min(14, height! - 4));
      const setup = await testRender(() => <BottomSurface {...props} />, { width, height: props.layout.bottomHeight });
      try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        for (const label of [...controls[mode.kind]!, "Tab read details"]) expect(frame, `${mode.kind}:\n${frame}`).toContain(label);
      } finally { setup.renderer.destroy(); }
    }
  });
}

test("expanded permission reading reaches the tail, survives resize, and restores note and cursor", async () => {
  const mode = readingModes[0]!;
  const props = readingPanelProps(mode, 80, 12);
  props.gateFocus = "reject";
  props.gateFeedback = "Keep my note";
  props.gateFeedbackCursor = 4;
  const [width, setWidth] = createSignal(80);
  const [height, setHeight] = createSignal(16);
  let reader!: ReturnType<typeof createReadingController>;
  const setup = await testRender(() => {
    const document = createMemo(() => projectReadingSurface(mode, { ...readingOptions, width: width(), height: 11, permissionReject: true }));
    reader = createReadingController({ document, liveKinds: () => [mode.kind], width, height: () => height() - 4 });
    return <box flexDirection="column" width="100%" height="100%">
      <box height={3}><text content="APP HEADER" /></box>
      <box flexDirection="column" flexGrow={1} visible={!reader.expanded()}>
        <BottomSurface {...props} promptZone={reader.active() ? "body" : "options"} />
      </box>
      <Show when={reader.expanded()}>
        <box flexGrow={1} />
        <ReadingOverlay controller={reader} width={width()} height={height() - 4} />
      </Show>
      <box height={1}><text content="APP FOOTER" /></box>
    </box>;
  }, { width: 80, height: 16 });
  try {
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Keep my note");
    const cursor = setup.renderer.getCursorState();
    reader.handleKey({ name: "tab" });
    await setup.flush();
    expect(setup.renderer.getCursorState().visible).toBe(false);
    reader.handleKey({ name: "end" });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("READABLE-LINE-24");
    expect(setup.captureCharFrame().trimEnd().split("\n").at(-1)).toContain("APP FOOTER");
    setWidth(120); setHeight(40); setup.resize(120, 40);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("READABLE-LINE-24");
    setWidth(80); setHeight(16); setup.resize(80, 16);
    reader.handleKey({ name: "escape" });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("Keep my note");
    expect(setup.renderer.getCursorState()).toEqual(cursor);
    reader.handleKey({ name: "tab" });
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("READABLE-LINE-24");
  } finally { setup.renderer.destroy(); }
});

test("compact reading shields the mounted native editor from mouse focus, selection and scroll", async () => {
  let reader!: ReturnType<typeof createReadingController>;
  let editor!: TextareaRenderable;
  const setup = await testRender(() => {
    reader = createReadingController({
      document: () => ({ kind: "model", identity: "model", key: "item", title: "Model", blocks: [{ text: "short" }], enabled: true, hidden: false }),
      liveKinds: () => ["model"], width: () => 80, height: () => 20,
    });
    return <box width="100%" height="100%" flexDirection="column">
      <box height={3} />
      <textarea ref={editor} height={12} width={80} initialValue={Array.from({ length: 50 }, (_, i) => `Editor line ${i}`).join("\n")} focused={!reader.active()} />
      <Show when={reader.active()}><ReadingOverlay controller={reader} width={80} height={20} /></Show>
    </box>;
  }, { width: 80, height: 24 });
  try {
    await setup.flush();
    reader.handleKey({ name: "tab" });
    await setup.flush();
    expect(reader.expanded()).toBe(false);
    const position = { cursor: editor.cursorOffset, scroll: editor.scrollY };
    await setup.mockMouse.scroll(8, 5, "down");
    await setup.mockMouse.click(8, 6);
    await setup.mockMouse.drag(2, 4, 15, 6);
    await setup.flush();
    expect(editor.focused).toBe(false);
    expect({ cursor: editor.cursorOffset, scroll: editor.scrollY }).toEqual(position);
    reader.handleKey({ name: "escape" });
    await setup.flush();
    expect(editor.focused).toBe(true);
    await setup.mockMouse.click(8, 6);
    expect(editor.cursorOffset).not.toBe(position.cursor);
  } finally { setup.renderer.destroy(); }
});
