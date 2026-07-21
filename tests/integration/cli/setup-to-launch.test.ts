import { describe, expect, test } from "bun:test";
import { writeSetupConfiguration } from "../../../src/setup/config-writer";
import { runCli, withTempProject } from "./support";

/**
 * Setup-to-launch journey (D): the boundary between first-run configuration
 * and a runnable host. Setup writes a provider registry + .env into an isolated
 * user-config dir; a real CLI diagnostic, launched from a separate project dir,
 * must load that config (base URL, model, and the credential Setup persisted).
 * This proves the config Setup writes is exactly what the CLI reads, without
 * launching the interactive TUI.
 */
describe("Setup-to-launch journey", () => {
  test("a real CLI doctor reflects config written by guided Setup", async () => {
    await withTempProject("vesicle-setup-launch-", async (projectDir, configDir) => {
      const written = await writeSetupConfiguration(
        {
          baseUrl: "https://api.vesicle-journey.test/v1",
          apiKey: "journey-secret",
          modelIds: ["journey-model"],
          defaultModel: "journey-model",
          permissionMode: "MANUAL",
        },
        { VESICLE_CONFIG_DIR: configDir },
      );
      expect(written.providerPath.startsWith(configDir)).toBe(true);

      const result = await runCli(["doctor"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      // The CLI diagnostic reports the provider Setup wrote, proving config
      // crossed the Setup -> runnable-host boundary and was loaded from the
      // isolated dir, not inherited from the host.
      expect(result.stdout).toContain("Base URL: https://api.vesicle-journey.test/v1");
      expect(result.stdout).toContain("Model: journey-model");
      expect(result.stdout).toContain("API key: available");
      expect(result.stdout).toContain(configDir);
    });
  });
});
