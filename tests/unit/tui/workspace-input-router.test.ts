import { describe, expect, test } from "bun:test";
import { routeWorkspaceKey, type WorkspaceRouterPorts } from "../../../src/tui/workspace/input-router";
import type { TuiKeyEvent } from "../../../src/tui/decision-interaction";

function key(name: string, mods: Partial<TuiKeyEvent> = {}): TuiKeyEvent {
  return { name, ...mods } as TuiKeyEvent;
}

function makePorts(overrides: Partial<WorkspaceRouterPorts> = {}): WorkspaceRouterPorts & {
  calls: Record<string, number>;
  surfaces: Record<string, boolean>;
} {
  const calls: Record<string, number> = {};
  const surfaces: Record<string, boolean> = {
    quickOpen: false, findings: false, dialog: false, opsBar: false,
    find: false, goto: false, saveAs: false,
  };
  const surface = (name: string) => ({
    active: () => surfaces[name]!,
    handle: () => { calls[name] = (calls[name] ?? 0) + 1; return true; },
  });
  return {
    pageIsWorkspace: () => true,
    dialogActionPending: () => false,
    quickOpen: surface("quickOpen"),
    findings: surface("findings"),
    dialog: surface("dialog"),
    opsBar: surface("opsBar"),
    find: surface("find"),
    goto: surface("goto"),
    saveAs: surface("saveAs"),
    globalKeys: () => { calls.global = (calls.global ?? 0) + 1; return false; },
    regionKeys: () => { calls.region = (calls.region ?? 0) + 1; return true; },
    ...overrides,
    calls,
    surfaces,
  };
}

describe("workspace input router: fixed priority order", () => {
  test("quick-open outranks every later surface and the regions", () => {
    const ports = makePorts();
    ports.surfaces.quickOpen = true;
    expect(routeWorkspaceKey(key("x"), ports)).toBe(true);
    expect(ports.calls.quickOpen).toBe(1);
    expect(ports.calls.findings ?? 0).toBe(0);
    expect(ports.calls.dialog ?? 0).toBe(0);
    expect(ports.calls.region ?? 0).toBe(0);
  });

  test("priority is quick-open → findings → dialog → ops → find → goto → save-as", () => {
    const order = ["quickOpen", "findings", "dialog", "opsBar", "find", "goto", "saveAs"] as const;
    for (const [i, surface] of order.entries()) {
      const ports = makePorts();
      ports.surfaces[surface] = true;
      // Every earlier surface is inactive; only `surface` may consume.
      routeWorkspaceKey(key("x"), ports);
      for (const [j, other] of order.entries()) {
        if (j < i) expect(ports.calls[other] ?? 0).toBe(0);
      }
      expect(ports.calls[surface]).toBe(1);
      expect(ports.calls.region ?? 0).toBe(0);
    }
  });

  test("a consuming surface short-circuits the regions", () => {
    const ports = makePorts();
    ports.surfaces.findings = true;
    expect(routeWorkspaceKey(key("x"), ports)).toBe(true);
    expect(ports.calls.region ?? 0).toBe(0);
    expect(ports.calls.global ?? 0).toBe(0);
  });

  test("with two surfaces active the earlier priority wins and the later is never called", () => {
    // This pins the ORDER itself: a permuted if-chain would pass the
    // single-surface tests but fails here (the plan's stop condition forbids
    // relaxing the priority).
    const quickFind = makePorts();
    quickFind.surfaces.quickOpen = true;
    quickFind.surfaces.findings = true;
    expect(routeWorkspaceKey(key("x"), quickFind)).toBe(true);
    expect(quickFind.calls.quickOpen).toBe(1);
    expect(quickFind.calls.findings ?? 0).toBe(0);

    const dialogFind = makePorts();
    dialogFind.surfaces.dialog = true;
    dialogFind.surfaces.find = true;
    expect(routeWorkspaceKey(key("x"), dialogFind)).toBe(true);
    expect(dialogFind.calls.dialog).toBe(1);
    expect(dialogFind.calls.find ?? 0).toBe(0);

    const findSave = makePorts();
    findSave.surfaces.find = true;
    findSave.surfaces.saveAs = true;
    expect(routeWorkspaceKey(key("x"), findSave)).toBe(true);
    expect(findSave.calls.find).toBe(1);
    expect(findSave.calls.saveAs ?? 0).toBe(0);
  });

  test("global keys run before the region dispatch", () => {
    const ports = makePorts();
    ports.globalKeys = () => { ports.calls.global = 1; return true; };
    expect(routeWorkspaceKey(key("f6"), ports)).toBe(true);
    expect(ports.calls.region ?? 0).toBe(0);
  });

  test("region dispatch consumes the key when its handler returns true", () => {
    const ports = makePorts();
    expect(routeWorkspaceKey(key("x"), ports)).toBe(true);
    expect(ports.calls.region).toBe(1);
  });

  test("non-workspace pages fall through before any surface check", () => {
    const ports = makePorts({ pageIsWorkspace: () => false });
    ports.surfaces.quickOpen = true;
    expect(routeWorkspaceKey(key("x"), ports)).toBe(false);
    expect(ports.calls.quickOpen ?? 0).toBe(0);
    expect(ports.calls.region ?? 0).toBe(0);
  });

  test("pending dialog actions swallow all input before surfaces", () => {
    const ports = makePorts({ dialogActionPending: () => true });
    ports.surfaces.quickOpen = true;
    expect(routeWorkspaceKey(key("x"), ports)).toBe(true);
    expect(ports.calls.quickOpen ?? 0).toBe(0);
    expect(ports.calls.region ?? 0).toBe(0);
  });
});
