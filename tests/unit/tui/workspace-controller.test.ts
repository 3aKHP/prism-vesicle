import { describe, expect, test } from "bun:test";
import { createWorkspaceController } from "../../../src/tui/workspace-controller";

describe("workspace controller (two-page shell)", () => {
  test("starts on the chat page", () => {
    const controller = createWorkspaceController();
    expect(controller.activePage()).toBe("chat");
    expect(controller.focusRegion()).toBe("tree");
  });

  test("togglePage switches between chat and workspace", () => {
    const controller = createWorkspaceController();
    controller.togglePage();
    expect(controller.activePage()).toBe("workspace");
    controller.togglePage();
    expect(controller.activePage()).toBe("chat");
  });

  test("setActivePage is idempotent and direct", () => {
    const controller = createWorkspaceController();
    controller.setActivePage("workspace");
    controller.setActivePage("workspace");
    expect(controller.activePage()).toBe("workspace");
    controller.setActivePage("chat");
    expect(controller.activePage()).toBe("chat");
  });
});
