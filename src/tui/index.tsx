import { render } from "@3akhp/opentui-solid";
import { App, type AppProps } from "./app";
import { createTerminalTitleController } from "./terminal-title";
import { runHostShutdownCleanups } from "../core/process/shutdown";
import {
  createThemePreferenceController,
  parseEnvTheme,
  readProjectThemePreference,
  type ThemePreferenceController,
} from "./theme-preference-controller";

export type RunTuiOptions = {
  dangerouslySkipPermissions?: boolean;
  resume?: boolean;
  bootstrapOnly?: boolean;
  /** Process-scoped `--dark`/`--light` initial preference, if supplied on the launch command. */
  themePreference?: "dark" | "light";
};

async function resolveThemeController(rootDir: string, cliPreference: "dark" | "light" | undefined): Promise<ThemePreferenceController> {
  const envParse = parseEnvTheme(process.env.VESICLE_THEME);
  const projectRead = await readProjectThemePreference(rootDir);
  const project = projectRead.ok ? { theme: projectRead.theme } : { diagnostic: projectRead.diagnostic };
  return createThemePreferenceController({ rootDir, cliPreference, envParse, project });
}

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  const rootDir = process.cwd();
  const terminalTitle = createTerminalTitleController();
  const theme = await resolveThemeController(rootDir, options.themePreference);
  theme.applyStartup();
  const themeProps: AppProps = {
    dangerouslySkipPermissions: options.dangerouslySkipPermissions === true,
    initialResume: options.resume === true,
    bootstrapOnly: options.bootstrapOnly === true,
    theme,
    terminalTitle,
    // The renderer must be destroyed first; only then start host cleanup and
    // force a normal exit. Waiting for onDestroy before cleanup leaves Bun stuck
    // after this App has rendered (observed with `bun run dev` Ctrl+C).
    onExit: () => {
      terminalTitle.clear();
      void runHostShutdownCleanups().finally(() => process.exit(process.exitCode ?? 0));
    },
  };
  await render(() => <App {...themeProps} />, {
    exitOnCtrlC: false,
    useKittyKeyboard: { events: true },
  });
}
