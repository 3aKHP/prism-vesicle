import { describe, expect, test } from "bun:test";
import {
  composeStatus,
  dialogStatus,
  editorStatus,
  findingsStatus,
  inputBarStatus,
  truncatePath,
  treeStatus,
  viewerStatus,
  type StatusSegment,
} from "../../../../src/tui/workspace/status";
import { displayWidth } from "../../../../src/tui/format";

const WIDTHS = [56, 80, 100, 140];

/** Every output of a status builder must fit its budget (Issue #118 §8). */
function fitsAt(builder: (budget: number) => string): void {
  for (const w of WIDTHS) {
    const line = builder(w);
    expect(displayWidth(line)).toBeLessThanOrEqual(w);
  }
}

describe("workspace status: composeStatus priority", () => {
  test("drops low-priority segments before high-priority; critical never drops", () => {
    const segs: StatusSegment[] = [
      { text: "keep0", priority: "critical" },
      { text: "keep1", priority: "high" },
      { text: "drop-low", priority: "low" },
    ];
    // Budget forces a drop; low goes first, critical + high survive.
    expect(composeStatus(segs, 14)).toBe("keep0 · keep1");
    expect(composeStatus(segs, 14)).not.toContain("drop-low");
  });

  test("a shrink segment middle-truncates instead of dropping", () => {
    const segs: StatusSegment[] = [
      { text: "critical-keep", priority: "critical" },
      { text: "workspace/cards/very-long-card-name.md", priority: "high", shrink: true },
    ];
    const line = composeStatus(segs, 40);
    expect(displayWidth(line)).toBeLessThanOrEqual(40);
    // The path was truncated (ellipsis present), the critical marker survived.
    expect(line).toContain("...");
    expect(line).toContain("critical-keep");
  });

  test("never exceeds budget even with many non-shrinkable criticals", () => {
    const segs: StatusSegment[] = [
      { text: "alpha-beta-gamma-delta-epsilon-zeta-eta", priority: "critical" },
      { text: "theta-iota-kappa-lambda-mu", priority: "critical" },
    ];
    expect(displayWidth(composeStatus(segs, 30))).toBeLessThanOrEqual(30);
  });

  test("never exceeds budget for adversarial inputs (universal width guarantee)", () => {
    const many: StatusSegment[] = Array.from({ length: 5 }, (_, i) => ({
      text: `critical-segment-${i}-xxxx`, priority: "critical" as const,
    }));
    for (const budget of [12, 20, 30, 56, 80]) {
      expect(displayWidth(composeStatus(many, budget))).toBeLessThanOrEqual(budget);
    }
    const mixed: StatusSegment[] = [
      { text: "fixed-long-critical-string", priority: "critical" },
      { text: "another-critical", priority: "critical" },
      { text: "shrink/path/here", priority: "high", shrink: true },
    ];
    for (const budget of [15, 25, 40]) {
      expect(displayWidth(composeStatus(mixed, budget))).toBeLessThanOrEqual(budget);
    }
  });
});

describe("workspace status: tree surface", () => {
  test("fits every width and keeps nav/open/v plus the current state", () => {
    fitsAt((w) => treeStatus({ budget: w, selectedIsFile: true, validation: "✗ 2" }));
  });

  test("at 56 cols keeps nav, open, v validate, and the validation verdict", () => {
    const line = treeStatus({ budget: 55, selectedIsFile: true, validation: "✗ 2" });
    expect(displayWidth(line)).toBeLessThanOrEqual(55);
    expect(line).toContain("↑↓ nav");
    expect(line).toContain("Enter open");
    expect(line).toContain("v validate");
    expect(line).toContain("✗ 2");
  });

  test("omits `v validate` when the selection is not a file", () => {
    const line = treeStatus({ budget: 80, selectedIsFile: false, validation: "" });
    expect(line).not.toContain("v validate");
  });

  test("file-management hints appear at wide widths and drop at narrow", () => {
    expect(treeStatus({ budget: 140, selectedIsFile: true, validation: "" })).toContain("d delete");
    // At 56 the low-priority delete hint is dropped to keep the core nav/open/v.
    expect(treeStatus({ budget: 55, selectedIsFile: true, validation: "✗ 2" })).not.toContain("d delete");
  });
});

describe("workspace status: viewer surface", () => {
  test("fits every width with ASCII, long, and CJK paths", () => {
    for (const target of ["card.md", "workspace/cards/very-long-card-name.md", "工作区/卡片/角色卡.md"]) {
      fitsAt((w) => viewerStatus({
        budget: w, target, mode: "preview", flags: "", validation: "✗ 2",
        toggleHint: "m edit", canViewFindings: true,
      }));
    }
  });

  test("a long path never pushes the validation verdict or Esc out of view", () => {
    const line = viewerStatus({
      budget: 80, target: "workspace/cards/very-long-card-name.md", mode: "preview",
      flags: "RO", validation: "✗ 2", toggleHint: "m edit", canViewFindings: true,
    });
    expect(displayWidth(line)).toBeLessThanOrEqual(80);
    expect(line).toContain("✗ 2");
    expect(line).toContain("Esc");
    expect(line).toContain("preview");
  });

  test("a CJK path middle-truncates and still fits with the verdict visible", () => {
    const line = viewerStatus({
      budget: 40, target: "工作区/卡片/超长角色卡名称测试.md", mode: "preview",
      flags: "", validation: "⚠ 1", toggleHint: "", canViewFindings: false,
    });
    expect(displayWidth(line)).toBeLessThanOrEqual(40);
    expect(line).toContain("⚠ 1");
    expect(line).toContain("...");
  });

  test("a long CJK path compresses before m/v actions drop at 79 columns (#118 review r2)", () => {
    // The real 80-column budget is 79; the path must shrink so the reachable
    // m/v actions survive, rather than being crowded out by the path.
    const line = viewerStatus({
      budget: 79, target: "workspace/很长很长的路径/角色卡.md", mode: "preview",
      flags: "RO · truncated", validation: "✗ 7 · ⚠ 3", toggleHint: "m source", canViewFindings: true,
    });
    expect(displayWidth(line)).toBeLessThanOrEqual(79);
    expect(line).toContain("v findings");
    expect(line).toContain("m source");
  });
});

describe("workspace status: editor surface", () => {
  test("fits every width; keeps target/cursor/Ctrl+S/Esc, drops find/goto/external at narrow", () => {
    const narrow = editorStatus({
      budget: 56, target: "workspace/cards/mira.md", dirtyMark: "●", diskMark: "",
      cursor: "Ln 12:5", validation: "",
    });
    expect(displayWidth(narrow)).toBeLessThanOrEqual(56);
    expect(narrow).toContain("Ctrl+S save");
    expect(narrow).toContain("Esc");
    expect(narrow).toContain("Ln 12:5");
    // Secondary hints drop before the core save/escape.
    expect(narrow).not.toContain("Ctrl+F find");

    const wide = editorStatus({
      budget: 140, target: "mira.md", dirtyMark: "●", diskMark: "",
      cursor: "Ln 1:1", validation: "",
    });
    expect(wide).toContain("Ctrl+F find");
  });

  test("a dirty buffer shows the stale verdict and still fits with Ctrl+S", () => {
    const line = editorStatus({
      budget: 64, target: "workspace/cards/long-card-name.md", dirtyMark: "●", diskMark: "",
      cursor: "Ln 3:5", validation: "validation stale",
    });
    expect(displayWidth(line)).toBeLessThanOrEqual(64);
    expect(line).toContain("validation stale");
    expect(line).toContain("Ctrl+S save");
  });
});

describe("workspace status: findings surface", () => {
  test("Enter jump appears only when canJump is true", () => {
    expect(findingsStatus({ budget: 80, canJump: true })).toContain("Enter jump");
    expect(findingsStatus({ budget: 80, canJump: false })).not.toContain("Enter jump");
  });
});

describe("workspace status: input bars and dialogs", () => {
  test("input bar keeps the cursor glyph and shrinks a long draft", () => {
    const line = inputBarStatus({
      budget: 44, label: "save as:",
      draft: "workspace/deeply/nested/renamed-target-name.md▌", choices: "Enter save · Esc close",
    });
    expect(displayWidth(line)).toBeLessThanOrEqual(44);
    // truncateMiddle keeps the tail, so the cursor glyph at the end survives.
    expect(line).toContain("▌");
    expect(line).toContain("...");
  });

  test("dialog keeps the choices and shrinks the target path", () => {
    const line = dialogStatus({
      budget: 64, lead: "delete workspace/cards/very-long-card-name.md?",
      choices: "y delete · any other key cancels",
    });
    expect(displayWidth(line)).toBeLessThanOrEqual(64);
    expect(line).toContain("y delete");
    expect(line).toContain("...");
  });
});

describe("workspace status: status note (controller status() text)", () => {
  test("builders render the note, and it survives width pressure (#118 review)", () => {
    expect(editorStatus({ budget: 140, target: "x.md", dirtyMark: "", diskMark: "", cursor: "Ln 1:1", validation: "", note: "saved x.md" })).toContain("saved x.md");
    expect(viewerStatus({ budget: 140, target: "x.md", mode: "preview", flags: "", validation: "", toggleHint: "", canViewFindings: false, note: "reloaded x.md" })).toContain("reloaded x.md");
    expect(treeStatus({ budget: 140, selectedIsFile: true, validation: "", note: "select a file to validate" })).toContain("select a file to validate");
    // The note is critical: under width pressure it stays while a path truncates.
    const line = editorStatus({ budget: 60, target: "workspace/cards/very-long-name.md", dirtyMark: "", diskMark: "", cursor: "Ln 1:1", validation: "", note: "failed: disk full" });
    expect(displayWidth(line)).toBeLessThanOrEqual(60);
    expect(line).toContain("failed: disk full");
  });
});

describe("workspace status: truncatePath", () => {
  test("never reports a width wider than the budget", () => {
    for (const p of ["a.md", "workspace/cards/very-long-card-name.md", "工作区/卡片/角色卡.md"]) {
      for (const b of [8, 16, 30, 80]) {
        expect(displayWidth(truncatePath(p, b))).toBeLessThanOrEqual(b);
      }
    }
  });
});
