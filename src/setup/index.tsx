import { render } from "@opentui/solid";
import { SetupApp, type SetupCompletion } from "./app";

export async function runGuidedSetup(): Promise<SetupCompletion> {
  let completion: SetupCompletion = { launch: false };
  await render(() => <SetupApp onComplete={(result) => { completion = result; }} />, {
    exitOnCtrlC: false,
    useKittyKeyboard: { events: true },
  });
  return completion;
}
