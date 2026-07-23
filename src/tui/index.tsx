import { render } from "@opentui/solid";
import { App } from "./app";

export type RunTuiOptions = {
  dangerouslySkipPermissions?: boolean;
  resume?: boolean;
};

export async function runTui(options: RunTuiOptions = {}): Promise<void> {
  await render(() => <App dangerouslySkipPermissions={options.dangerouslySkipPermissions === true} initialResume={options.resume === true} />, {
    exitOnCtrlC: false,
    useKittyKeyboard: { events: true },
  });
}
