/**
 * Shared pieces for the real-PTY smoke scripts (smoke-compact-pty.ts,
 * smoke-workspace-status-pty.ts) so the ANSI stripper and the mock provider /
 * engine-profile fixtures do not drift between copies (Issue #118 review).
 *
 * Behaviour note: stripAnsi here is the strict superset — it strips OSC,
 * DCS/SOS/PM/APC, full ECMA-48 CSI (with intermediates like `$`), and any
 * remaining two-byte escape, so private-mode query responses (e.g. OSC RGB
 * replies emitted on resize) cannot leak into the marker checks.
 */

/** Strip every ECMA-48 escape sequence and CR from a PTY byte stream. */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (query responses, terminal capabilities)
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\|\x1b[PX^_][^\x07]*\x07/g, "") // DCS / SOS / PM / APC
    .replace(/\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/g, "") // CSI (full ECMA-48, incl. intermediates like `$`)
    .replace(/\x1b./g, "") // any other two-byte escape
    .replace(/\r/g, "");
}

/** Mock OpenAI-compatible provider registry pointing at a local server `port`. */
export function providersYaml(port: number, contextWindow = 8000): string {
  return [
    "default:",
    "  provider: mock",
    "  model: mock-model",
    "providers:",
    "  mock:",
    "    protocol: openai-chat-compatible",
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    "    apiKeyEnv: MOCK_KEY",
    "    models:",
    "      - id: mock-model",
    "        limits:",
    `          contextWindow: ${contextWindow}`,
    "",
  ].join("\n");
}

/** Minimal ETL engine profile used by the smokes (assets/prompts/engines/etl.md). */
export const engineProfileYaml = [
  "id: etl", "displayName: Smoke ETL", "protocolVersion: v9.0-state-space",
  "systemPrompt:", "  - assets/prompts/shared/vesicle-base.md", "  - assets/prompts/engines/etl.md",
  "defaultTools:", "  - read_file", "validators: []", "stopGates: []", "stateRoots:",
  "  - workspace", "",
].join("\n");

export const MOCK_ENV = "MOCK_KEY=mock\n";
export const SHARED_BASE_PROMPT = "base";
export const ETL_PROMPT = "etl";
