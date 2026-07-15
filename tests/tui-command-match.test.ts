import { describe, expect, test } from "bun:test";
import type { Command } from "../src/tui/commands/types";
import { matchCommands } from "../src/tui/commands/match";

// A small synthetic command set that exercises every ranking tier without
// pulling in the real builtin registry (which would drag in theme/render
// modules). Ranking: 0 exact name, 1 name prefix, 2 alias prefix, 3 name
// substring, 4 alias substring, 5 description substring.
const commands: Command[] = [
  { name: "model", description: "switch the model", run: async () => {} },
  { name: "engine", aliases: ["profile"], description: "switch the engine", run: async () => {} },
  { name: "effort", description: "set provider thinking effort", run: async () => {} },
];

const names = (result: Command[]) => result.map((c) => c.name);

describe("matchCommands", () => {
  test("empty query returns every command in declaration order", () => {
    expect(names(matchCommands("", commands))).toEqual(["model", "engine", "effort"]);
  });

  test("whitespace-only query is treated as empty", () => {
    expect(names(matchCommands("   ", commands))).toEqual(["model", "engine", "effort"]);
  });

  test("exact name match ranks first", () => {
    expect(names(matchCommands("model", commands))).toEqual(["model"]);
  });

  test("name prefix matches and ranks above substrings", () => {
    expect(names(matchCommands("mo", commands))).toEqual(["model"]);
  });

  test("alias prefix matches", () => {
    expect(names(matchCommands("prof", commands))).toEqual(["engine"]);
  });

  test("name substring matches", () => {
    expect(names(matchCommands("ffo", commands))).toEqual(["effort"]);
  });

  test("description substring matches, ties broken by declaration order", () => {
    // both model and engine descriptions contain "switch"
    expect(names(matchCommands("switch", commands))).toEqual(["model", "engine"]);
  });

  test("prefix outranks substring, which outranks description", () => {
    // "e": engine and effort name prefixes (tier 1), model name substring (tier 3).
    expect(names(matchCommands("e", commands))).toEqual(["engine", "effort", "model"]);
  });

  test("no match returns an empty list", () => {
    expect(matchCommands("xyzzy", commands)).toEqual([]);
  });

  test("matching is case-insensitive", () => {
    expect(names(matchCommands("MODEL", commands))).toEqual(["model"]);
  });

  test("does not mutate the input command list", () => {
    const snapshot = [...commands];
    matchCommands("model", commands);
    expect(commands).toEqual(snapshot);
  });
});
