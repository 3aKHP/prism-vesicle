import { describe, expect, test } from "bun:test";
import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli, withTempProject } from "./support";

/** Connection-refused provider: no network egress, fails the round fast. */
const DEAD_PROVIDER_YAML = `default:
  provider: local
  model: stub
providers:
  local:
    protocol: openai-chat-compatible
    baseUrl: http://127.0.0.1:1/v1
    apiKeyEnv: FAKE_KEY
    defaultModel: stub
    models:
      - id: stub
        capabilities:
          streaming: false
          tools: true
        limits:
          contextWindow: 128000
          maxOutputTokens: 4096
`;

describe("vesicle once project-root creation (#291)", () => {
  test("a squatted root warns on stderr while the other roots are created", async () => {
    await withTempProject("vesicle-cli-roots-", async (projectDir, configDir) => {
      await writeFile(join(configDir, "providers.yaml"), DEAD_PROVIDER_YAML);
      await writeFile(join(projectDir, "novels"), "squat\n");

      const result = await runCli(["once", "hello"], { cwd: projectDir, configDir, env: { FAKE_KEY: "x" } });

      // The warning fires during session birth, before the dead provider
      // fails the round (non-zero exit).
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Project root "novels" could not be created');
      // Best effort: the remaining writable roots still appear.
      expect((await lstat(join(projectDir, "workspace"))).isDirectory()).toBe(true);
      expect((await lstat(join(projectDir, "tmp"))).isDirectory()).toBe(true);
    });
  });
});
