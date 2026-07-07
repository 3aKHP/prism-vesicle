import { spawn } from "node:child_process";
import type { CliRenderer } from "@opentui/core";

export async function copySelectionToClipboard(renderer: CliRenderer): Promise<boolean> {
  const selectedText = renderer.getSelection()?.getSelectedText();
  if (!selectedText) return false;

  const copiedViaTerminal = renderer.copyToClipboardOSC52(selectedText);
  const copiedViaPlatform = await copyTextWithPlatformClipboard(selectedText);

  return copiedViaTerminal || copiedViaPlatform;
}

async function copyTextWithPlatformClipboard(text: string): Promise<boolean> {
  if (process.platform === "win32") {
    return writeToProcess("powershell.exe", ["-NoProfile", "-Command", "$input | Set-Clipboard"], text);
  }

  if (process.platform === "darwin") {
    return writeToProcess("pbcopy", [], text);
  }

  return (await writeToProcess("wl-copy", [], text)) || (await writeToProcess("xclip", ["-selection", "clipboard"], text));
}

function writeToProcess(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });

    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}
