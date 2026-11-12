import { expect, test } from "bun:test";
import { scanSurfaces } from "../../../scripts/check/migration/surfaces";

// Coverage derives from actual registration syntax, not naming or source text
// assertions. Missing candidates could silently shrink a migration's denominator.
test("enumerates tool, command and alias registrations independently of declaration names", () => {
  const rows = scanSurfaces("src/tui/commands/example.ts", `
    const renamed = { type: "function", function: { name: "write_file", description: "write", parameters: { type: "object" } } };
    function factory() { return [{ name: "rewind", aliases: ["checkpoint"], busyBehavior: afterLoop, description: "rewind", run() {} }]; }
  `);
  expect(rows.filter((r) => r.kind === "tool").map((r) => r.name)).toEqual(["write_file"]);
  expect(rows.filter((r) => r.kind === "tui-command").map((r) => r.name)).toEqual(["rewind"]);
  expect(rows.filter((r) => r.kind === "tui-alias").map((r) => r.name)).toEqual(["checkpoint"]);
});

test("collects computed persisted discriminants as well as inline metadata", () => {
  const rows = scanSurfaces("src/core/session/example.ts", `
    const CANDIDATE_SELECTION_KIND = "candidate-selection";
    const hostOnlyKinds = new Set(["session-title", "skill-catalog"]);
    append({ metadata: { kind: "compact-checkpoint-v1" } });
    if (record.metadata?.kind === "legacy-summary") replay();
  `);
  expect(rows.map((r) => r.name).sort()).toEqual(["candidate-selection", "compact-checkpoint-v1", "legacy-summary", "session-title", "skill-catalog"]);
});

test("configuration and provider options remain separate reviewable entries", () => {
  const rows = scanSurfaces("src/config/env.ts", `
    export type ResponsesProfile = "openai-public" | "codex-http-relay";
    export type Limits = { reserveOutputTokens?: number; enabled?: boolean };
    if (key === "maxTokens") parseNumber();
  `);
  expect(rows.filter((r) => r.kind === "config-field").map((r) => r.name)).toEqual(["Limits.enabled", "Limits.reserveOutputTokens"]);
  expect(rows.filter((r) => r.kind === "config-key").map((r) => r.name)).toEqual(["maxTokens"]);
  expect(rows.filter((r) => r.kind === "provider-option").map((r) => r.name)).toHaveLength(2);
  expect(rows.every((r) => r.capabilityIds.length === 0 && r.nonCapabilityReason === null)).toBe(true);
});

test("enumerates CLI parser commands, flags and usage without treating comments as registrations", () => {
  const rows = scanSurfaces("src/cli/args.ts", `
    const KNOWN_COMMANDS = new Set(["doctor", "setup"]);
    const dangerousFlag = "--dangerously-skip-permissions";
    console.error("Usage: vesicle debug markdown-runtime");
    // const invented = "--not-an-entry";
  `);
  expect(rows.filter((r) => r.kind === "cli-command").map((r) => r.name)).toEqual(["doctor", "setup"]);
  expect(rows.filter((r) => r.kind === "cli-flag").map((r) => r.name)).toEqual(["--dangerously-skip-permissions"]);
  expect(rows.filter((r) => r.kind === "cli-usage").map((r) => r.name)).toEqual(["vesicle debug markdown-runtime"]);
});
