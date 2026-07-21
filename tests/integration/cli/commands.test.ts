import { stat } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { runCli, seedProvidersConfig, withTempProject } from "./support";
import packageJson from "../../../package.json";

/**
 * CLI source journey (A): drive the real CLI as a subprocess through its
 * non-interactive surface and assert exit codes, output contracts, and config
 * isolation. These paths previously had no behavioural coverage — the entry
 * command dispatch was only inferred from main.ts source text.
 */
describe("CLI source journey: non-interactive commands", () => {
  test("doctor exits 0, reports header and invocation cwd", async () => {
    await withTempProject("vesicle-cli-doctor-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["doctor"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Prism Vesicle Doctor");
      // Behavioural chdir invariant: the process reports the invocation cwd,
      // proving main.ts did not redirect it.
      expect(result.stdout).toContain(`Project: ${projectDir}`);
    });
  });

  test("debug markdown-runtime emits a JSON diagnostic on stdout", async () => {
    await withTempProject("vesicle-cli-debug-", async (projectDir, configDir) => {
      const result = await runCli(["debug", "markdown-runtime"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean };
      expect(typeof parsed.ok).toBe("boolean");
    });
  });

  test("assets status reports the asset layers", async () => {
    await withTempProject("vesicle-cli-assets-", async (projectDir, configDir) => {
      const result = await runCli(["assets", "status"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Prism Vesicle Assets");
    });
  });

  test("assets command failures exit cleanly without leaking a runtime stack", async () => {
    await withTempProject("vesicle-cli-assets-error-", async (projectDir, configDir) => {
      const result = await runCli(["assets", "init", "--bogus"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe("Asset scope accepts only --global.");
      expect(result.stderr).not.toContain("src/cli/");
      expect(result.stderr).not.toContain("Bun v");
    });
  });

  test("VESICLE_CONFIG_DIR routes config to the isolated dir, not the host path", async () => {
    await withTempProject("vesicle-cli-config-", async (projectDir, configDir) => {
      await seedProvidersConfig(configDir);
      const result = await runCli(["doctor"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      // The provider-env path is derived from the config dir, so its presence
      // proves the env var was honoured and no host config leaked in.
      expect(result.stdout).toContain(configDir);
      expect(result.stdout).not.toMatch(/\.config\/prism-vesicle/);
    });
  });

  test("assets materialize writes a project override under the invocation cwd", async () => {
    await withTempProject("vesicle-cli-materialize-", async (projectDir, configDir) => {
      const target = "assets/prompts/shared/vesicle-base.md";
      const result = await runCli(["assets", "materialize", target], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Initialized project asset override:");
      await expect(stat(`${projectDir}/${target}`)).resolves.toBeTruthy();
    });
  });

  test("unknown two-arg command exits 1 with a usage error", async () => {
    await withTempProject("vesicle-cli-unknown-", async (projectDir, configDir) => {
      const result = await runCli(["frobnicate", "extra"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown command or project directory: frobnicate");
    });
  });

  test("argument-shaped commands surface their usage contract on misuse", async () => {
    await withTempProject("vesicle-cli-usage-", async (projectDir, configDir) => {
      const once = await runCli(["once"], { cwd: projectDir, configDir });
      expect(once.exitCode).toBe(1);
      expect(once.stderr).toContain("Usage: vesicle once");

      const prompt = await runCli(["prompt"], { cwd: projectDir, configDir });
      expect(prompt.exitCode).toBe(1);
      expect(prompt.stderr).toContain("Usage: vesicle prompt");

      const debug = await runCli(["debug", "bogus"], { cwd: projectDir, configDir });
      expect(debug.exitCode).toBe(1);
      expect(debug.stderr).toContain("Usage: vesicle debug markdown-runtime");
    });
  });

  test("launch rejects a missing project directory with a clean exit", async () => {
    await withTempProject("vesicle-cli-launch-missing-", async (projectDir, configDir) => {
      const result = await runCli(["launch", "missing-project"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Project directory");
      // No runtime stack leaked to the user-facing error surface.
      expect(result.stderr).not.toContain("src/cli/project-target.ts");
      expect(result.stderr).not.toContain("Bun v");
    });
  });

  test("--version / -v print the package version and exit 0", async () => {
    await withTempProject("vesicle-cli-version-", async (projectDir, configDir) => {
      const long = await runCli(["--version"], { cwd: projectDir, configDir });
      expect(long.exitCode).toBe(0);
      expect(long.stderr).toBe("");
      expect(long.stdout.trim()).toBe(packageJson.version);

      const short = await runCli(["-v"], { cwd: projectDir, configDir });
      expect(short.exitCode).toBe(0);
      expect(short.stdout.trim()).toBe(packageJson.version);
    });
  });

  test("--help prints the global usage and exits 0", async () => {
    await withTempProject("vesicle-cli-help-", async (projectDir, configDir) => {
      const result = await runCli(["--help"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("--version");
    });
  });

  test("an unknown option exits 1 with a concise error", async () => {
    await withTempProject("vesicle-cli-unknown-opt-", async (projectDir, configDir) => {
      const result = await runCli(["--bogus"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown option: --bogus");
    });
  });

  test("top-level parsing leaves command-owned terminators to the command", async () => {
    await withTempProject("vesicle-cli-command-terminator-", async (projectDir, configDir) => {
      const result = await runCli(["prompt", "shape", "--", "--engine"], { cwd: projectDir, configDir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown argument: --");
      expect(result.stderr).not.toContain("Usage: vesicle [flags] -- [project-directory]");
    });
  });
});
