import { describe, expect, test } from "bun:test";
import { validateToolCallArguments } from "../../../src/core/tools/arguments";

describe("tool argument validation", () => {
  test("rejects empty arguments and keeps valid execution calls independent from replay", () => {
    const validated = validateToolCallArguments([
      { id: "valid", name: "read_file", arguments: "{}" },
      { id: "empty", name: "write_file", arguments: "" },
    ]);

    expect(validated.executable).toEqual([{ id: "valid", name: "read_file", arguments: "{}" }]);
    expect(validated.replayable).toEqual([
      { id: "valid", name: "read_file", arguments: "{}" },
      { id: "empty", name: "write_file", arguments: "{}" },
    ]);
    expect(validated.malformed).toEqual([
      expect.objectContaining({
        toolCallId: "empty",
        name: "write_file",
        reason: "invalid-json",
        originalLength: 0,
      }),
    ]);

    validated.executable[0]!.arguments = '{"path":"changed"}';
    expect(validated.replayable[0]!.arguments).toBe("{}");
  });
});
