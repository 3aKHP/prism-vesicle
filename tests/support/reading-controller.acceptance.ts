import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createReadingController } from "../../src/tui/reading/controller";
import { readingRows, type ReadingDocument } from "../../src/tui/reading/document";
import type { TuiKeyEvent } from "../../src/tui/decision-interaction";

const key = (name: string, extras: Partial<TuiKeyEvent> = {}): TuiKeyEvent => ({ name, ...extras });
function document(overrides: Partial<ReadingDocument> = {}): ReadingDocument {
  return {
    kind: "gate", identity: "request-1", key: "body", title: "Review",
    blocks: [{ text: Array.from({ length: 100 }, (_, i) => `paragraph ${i}`).join("\n") }],
    enabled: true, hidden: true, ...overrides,
  };
}
function harness(initial = document()) {
  return createRoot((dispose) => {
    const [surface, setSurface] = createSignal<ReadingDocument | null>(initial);
    const [live, setLive] = createSignal(["gate"]);
    const [width, setWidth] = createSignal(80);
    const [height, setHeight] = createSignal(20);
    const [obscured, setObscured] = createSignal(false);
    const reader = createReadingController({ document: surface, liveKinds: live, width, height, obscured });
    return { reader, setSurface, setLive, setWidth, setHeight, setObscured, dispose };
  });
}

describe("bottom-surface reading", () => {
  test.each(["tab", "enter", "return", "escape"])("%s only returns; the same prompt resumes its reading position", (name) => {
    const h = harness();
    try {
      expect(h.reader.handleKey(key("tab"))).toBe(true);
      expect(h.reader.expanded()).toBe(true);
      h.reader.handleKey(key("end"));
      expect(h.reader.start()).toBe(84);
      expect(h.reader.handleKey(key(name))).toBe(true);
      expect(h.reader.active()).toBe(false);
      h.reader.handleKey(key("tab", { shift: true }));
      expect(h.reader.start()).toBe(84);
    } finally { h.dispose(); }
  });

  test("short content stays compact, but shrinking can expand an active reader", () => {
    const original = document({ hidden: false, blocks: [{ text: "Short" }] });
    const h = harness(original);
    try {
      h.reader.handleKey(key("tab"));
      expect(h.reader.active()).toBe(true);
      expect(h.reader.expanded()).toBe(false);
      h.setSurface({ ...original, hidden: true });
      expect(h.reader.expanded()).toBe(true);
      h.setSurface(original);
      expect(h.reader.expanded()).toBe(true);
    } finally { h.dispose(); }
  });

  test("all other keys are consumed while reading and disabled business phases cannot enter", () => {
    const h = harness();
    try {
      h.reader.handleKey(key("tab"));
      for (const name of ["y", "n", "1", "v", "f6"]) expect(h.reader.handleKey(key(name))).toBe(true);
      h.setSurface(document({ enabled: false }));
      expect(h.reader.active()).toBe(false);
      expect(h.reader.handleKey(key("tab"))).toBe(false);
    } finally { h.dispose(); }
  });

  test("Workspace suppression and higher-priority prompts preserve only live owners", () => {
    const original = document();
    const h = harness(original);
    try {
      h.reader.handleKey(key("tab"));
      h.reader.handleKey(key("down"));
      h.setSurface(null);
      expect(h.reader.active()).toBe(false);
      expect(h.reader.handleKey(key("enter"))).toBe(false);
      h.setLive(["gate", "session-migration"]);
      h.setSurface(document({ kind: "session-migration", identity: "migration" }));
      expect(h.reader.active()).toBe(false);
      h.setSurface(original);
      expect(h.reader.active()).toBe(true);
      expect(h.reader.start()).toBe(1);
      h.setSurface(null);
      h.setLive([]);
      h.setLive(["gate"]);
      h.setSurface(original);
      expect(h.reader.active()).toBe(false);
      expect(h.reader.start()).toBe(0);
    } finally { h.dispose(); }
  });

  test("new request, selection and stage reset the reading state", () => {
    const h = harness();
    try {
      for (const next of [document({ identity: "request-2" }), document({ identity: "request-2", key: "stage-2" })]) {
        h.reader.handleKey(key("tab"));
        h.reader.handleKey(key("end"));
        h.setSurface(next);
        expect(h.reader.active()).toBe(false);
        expect(h.reader.start()).toBe(0);
      }
    } finally { h.dispose(); }
  });

  test("width reflow preserves the source paragraph and full graphemes", () => {
    const h = harness(document({ blocks: Array.from({ length: 40 }, (_, i) => ({ text: `段落 ${i} ${"中文 👩‍💻 ".repeat(20)}` })) }));
    try {
      h.reader.handleKey(key("tab"));
      for (let i = 0; i < 20; i += 1) h.reader.handleKey(key("down"));
      const before = h.reader.rows()[h.reader.start()]!;
      h.setWidth(44);
      const after = h.reader.rows()[h.reader.start()]!;
      expect(after.block).toBe(before.block);
      expect(after.offset).toBeLessThanOrEqual(before.offset);
      h.setWidth(120);
      expect(h.reader.rows()[h.reader.start()]!.block).toBe(before.block);
      h.setHeight(12);
      h.reader.handleKey(key("end"));
      expect(h.reader.start() + h.reader.capacity()).toBe(h.reader.rows().length);
    } finally { h.dispose(); }
    const lines = readingRows([{ text: "👩‍💻👩‍💻" }], 2);
    expect(lines.map((line) => line.text)).toEqual(["👩‍💻", "👩‍💻"]);
  });
});
