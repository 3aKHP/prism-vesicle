/**
 * Stable, script-process-scoped self-invocation for bundled Skill scripts.
 *
 * A bundled Skill script (such as the `skillify` publish wrappers) must invoke
 * the exact Vesicle runtime that launched it, instead of guessing `vesicle` is
 * on `PATH`. The CLI configures one process-lifetime argv prefix here after
 * determining the runtime shape; `run_skill_script` injects the derived values
 * into the filtered child environment of structured-argv Skill script children
 * only. `shell_exec` never receives them.
 *
 * The two environment variables are Host-owned: the caller/user environment
 * cannot override them, and persisted process/Skill events record only the
 * logical interpreter identity, never the absolute executable or entrypoint.
 */

const ENV_EXECUTABLE = "VESICLE_SELF_EXECUTABLE";
const ENV_ENTRYPOINT = "VESICLE_SELF_ENTRYPOINT";

export type VesicleSelfInvocation = {
  /** Absolute path to the executable that can re-invoke Vesicle (`process.execPath`). */
  executablePath: string;
  /**
   * Entrypoint module path for source/npm-bundle runs (`Bun.main`). Absent for
   * compiled single-file executables, which are self-contained.
   */
  entrypoint?: string;
};

let configured: VesicleSelfInvocation | undefined;

/**
 * Store the process-lifetime self-invocation prefix. Called once from the CLI
 * entry point after determining whether the runtime is a compiled binary or a
 * source/npm bundle. Subsequent calls replace the value for tests.
 */
export function configureSelfInvocation(config: VesicleSelfInvocation): void {
  configured = config;
}

/** Read the configured self-invocation, or `undefined` when not yet configured. */
export function getSelfInvocation(): VesicleSelfInvocation | undefined {
  return configured;
}

/** Clear the configured self-invocation (tests). */
export function clearSelfInvocation(): void {
  configured = undefined;
}

/**
 * Produce the Host-owned environment variables for a `run_skill_script` child.
 * Returns an empty record when no self-invocation is configured; the caller
 * (`run_skill_script`) decides whether that is a hard failure.
 */
export function selfInvocationEnvironment(): Record<string, string> {
  const config = configured;
  if (!config) return {};
  const env: Record<string, string> = { [ENV_EXECUTABLE]: config.executablePath };
  if (config.entrypoint !== undefined) env[ENV_ENTRYPOINT] = config.entrypoint;
  return env;
}
