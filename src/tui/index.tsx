import { render } from "@opentui/solid";
import { App, type AppProps } from "./app";
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
  const theme = await resolveThemeController(rootDir, options.themePreference);
  theme.applyStartup();
  const themeProps: AppProps = {
    dangerouslySkipPermissions: options.dangerouslySkipPermissions === true,
    initialResume: options.resume === true,
    bootstrapOnly: options.bootstrapOnly === true,
    theme,
  };
  await render(() => <App {...themeProps} />, {
    exitOnCtrlC: false,
    useKittyKeyboard: { events: true },
  });
}
