import { render } from "@3akhp/opentui-solid";
import { SetupApp, type SetupCompletion } from "./app";
import { createThemePreferenceController, parseEnvTheme } from "../tui/theme-preference-controller";

export type RunSetupOptions = {
  /** Process-scoped `--dark`/`--light` initial preference, if supplied on the launch command. */
  themePreference?: "dark" | "light";
};

export async function runGuidedSetup(options: RunSetupOptions = {}): Promise<SetupCompletion> {
  // Guided Setup has no selected project before project selection, so the
  // effective preference is CLI -> environment -> built-in (no project read).
  // If it launches a project afterwards, the launch path resolves that
  // project's preference normally.
  const theme = createThemePreferenceController({
    rootDir: process.cwd(),
    cliPreference: options.themePreference,
    envParse: parseEnvTheme(process.env.VESICLE_THEME),
    project: {},
  });
  theme.applyStartup();
  let completion: SetupCompletion = { launch: false };
  await render(() => <SetupApp onComplete={(result) => { completion = result; }} />, {
    exitOnCtrlC: false,
    useKittyKeyboard: { events: true },
  });
  return completion;
}
