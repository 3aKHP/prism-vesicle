import { render } from "@opentui/solid";
import { App } from "./app";

export async function runTui(): Promise<void> {
  await render(() => <App />, {
    exitOnCtrlC: false,
  });
}
