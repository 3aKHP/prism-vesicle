import { describe, expect, test } from "bun:test";
import { createSkillCommands } from "../../../src/tui/commands/skills";
import { renderSkillRefreshCard } from "../../../src/tui/skills/session-activation";
import type { SkillCommandContext } from "../../../src/tui/commands/types";
import type { SessionSkillCatalogRefresh, SkillCatalogDrift } from "../../../src/core/skills";
import type { Message } from "../../../src/tui/types";

function makeContext() {
  let messages: Message[] = [];
  const calls: string[] = [];
  const ctx = {
    setMessages: (updater: (prev: Message[]) => Message[]) => {
      messages = updater(messages);
    },
    async openSkillPicker() {
      calls.push("picker");
    },
    async activateSkill(name: string) {
      calls.push(`activate:${name}`);
    },
    async refreshSkillCatalog() {
      calls.push("refresh");
    },
  } as unknown as SkillCommandContext;
  const command = createSkillCommands(ctx).find((entry) => entry.name === "skill");
  if (!command) throw new Error("skill command missing");
  return { command, messages: () => messages, calls };
}

describe("/skill command", () => {
  test("/skill refresh forwards to the catalog refresh port without touching the transcript", async () => {
    const { command, messages, calls } = makeContext();
    await command.run("refresh", "/skill refresh");
    expect(calls).toEqual(["refresh"]);
    expect(messages()).toEqual([]);
  });

  test("/skill refresh rejects extra operands and --context-only with the usage line", async () => {
    const extra = makeContext();
    await extra.command.run("refresh now", "/skill refresh now");
    expect(extra.calls).toEqual([]);
    expect(extra.messages()).toEqual([
      { role: "user", content: "/skill refresh now" },
      { role: "system", content: "Usage: /skill [refresh | name [task|--context-only]]" },
    ]);

    const flagged = makeContext();
    await flagged.command.run("refresh --context-only", "/skill refresh --context-only");
    expect(flagged.calls).toEqual([]);
    expect(flagged.messages()).toHaveLength(2);
  });

  test("/skill <name> still routes to activation, so the reserved word does not swallow it", async () => {
    const { command, calls, messages } = makeContext();
    await command.run("alpha apply it", "/skill alpha apply it");
    expect(calls).toEqual(["activate:alpha"]);
    expect(messages()).toEqual([]);
  });
});

function driftStub(overrides: Partial<SkillCatalogDrift> = {}): SkillCatalogDrift {
  return {
    catalog: {} as SkillCatalogDrift["catalog"],
    snapshot: { catalogHash: "h", entries: [], omittedCount: 0, diagnosticsCount: 0 },
    events: [],
    added: [],
    reactivate: [],
    persisted: true,
    ...overrides,
  };
}

function refreshStub(drift: SkillCatalogDrift, appended: boolean, unbudgeted = false): SessionSkillCatalogRefresh {
  return { drift, appended, unbudgeted };
}

describe("renderSkillRefreshCard", () => {
  test("an in-sync catalog reports the no-op without any diff lines", () => {
    expect(renderSkillRefreshCard(refreshStub(driftStub(), false)))
      .toBe("Skill catalog already matches the installed Skills; nothing to re-freeze.");
    expect(renderSkillRefreshCard(refreshStub(driftStub({ persisted: false }), false)))
      .toBe("No Skills resolve under the current installation; nothing to freeze.");
  });

  test("a legacy freeze announces the frozen count", () => {
    const drift = driftStub({
      persisted: false,
      snapshot: { catalogHash: "h", entries: [{ name: "alpha", scope: "user", bodySha256: "a".repeat(64) }], omittedCount: 0, diagnosticsCount: 0 },
    });
    expect(renderSkillRefreshCard(refreshStub(drift, true)).split("\n")[0])
      .toBe("Skill catalog frozen for this session (1 Skill).");
  });

  test("a re-freeze reports changed, removed, and added entries with the re-activation hint", () => {
    const card = renderSkillRefreshCard(refreshStub(driftStub({
      events: [
        { kind: "changed", name: "alpha", mustReactivate: true },
        { kind: "changed", name: "beta", mustReactivate: false },
        { kind: "removed", name: "gone" },
      ],
      added: ["delta"],
    }), true));
    const lines = card.split("\n");
    expect(lines[0]).toBe("Skill catalog re-frozen at the current installation content.");
    expect(lines).toContain("- Changed: alpha (activate it again with /skill alpha)");
    expect(lines).toContain("- Changed: beta");
    expect(lines).toContain("- Removed: gone (no longer resolves under the current installation)");
    expect(lines).toContain("- Added: delta");
    expect(lines.at(-1)).toBe("The updated catalog applies from the next turn; earlier activation records stay in history.");

    // Config-unavailable degradation is disclosed instead of a silent unbudgeted freeze.
    const unbudgeted = renderSkillRefreshCard(refreshStub(driftStub({ added: ["delta"] }), true, true)).split("\n");
    expect(unbudgeted).toContain("- Added: delta");
    expect(unbudgeted).toContain("Provider configuration was unavailable; the catalog was frozen without a context-window budget.");
    expect(renderSkillRefreshCard(refreshStub(driftStub(), false, true)))
      .toBe("Skill catalog already matches the installed Skills; nothing to re-freeze.");
  });
});
