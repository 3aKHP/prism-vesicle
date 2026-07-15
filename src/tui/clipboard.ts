import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRenderer } from "@opentui/core";

export async function copySelectionToClipboard(renderer: CliRenderer): Promise<boolean> {
  const selectedText = renderer.getSelection()?.getSelectedText();
  if (!selectedText) return false;

  const copiedViaTerminal = renderer.copyToClipboardOSC52(selectedText);
  const copiedViaPlatform = await copyTextWithPlatformClipboard(selectedText);

  return copiedViaTerminal || copiedViaPlatform;
}

export async function readImageFromClipboard(): Promise<Uint8Array | undefined> {
  if (process.platform === "win32" || isWsl()) {
    const image = await readWindowsClipboardImage();
    if (image) return image;
  }
  if (process.platform === "darwin") {
    const dir = await mkdtemp(join(tmpdir(), "vesicle-clipboard-"));
    const path = join(dir, "clipboard.png");
    try {
      const scripts = [
        "set png_data to (the clipboard as «class PNGf»)",
        `set fp to open for access POSIX file "${path}" with write permission`,
        "write png_data to fp",
        "close access fp",
      ];
      const result = await captureProcess("osascript", scripts.flatMap((script) => ["-e", script]));
      if (!result) return undefined;
      const bytes = await readFile(path).catch(() => undefined);
      return bytes?.length ? bytes : undefined;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (process.platform === "linux") {
    const wayland = await captureProcess("wl-paste", ["--no-newline", "--type", "image/png"]);
    if (wayland?.length) return wayland;
    const x11 = await captureProcess("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
    if (x11?.length) return x11;
  }
  return undefined;
}

export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

async function readWindowsClipboardImage(): Promise<Uint8Array | undefined> {
  const script = [
    "$img = Get-Clipboard -Format Image",
    "if ($null -eq $img) { exit 2 }",
    "$stream = [System.IO.MemoryStream]::new()",
    "$img.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)",
    "[Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const commands = windowsClipboardCommands(isWsl());
  for (const command of commands) {
    const output = await captureProcess(command, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
    if (!output?.length) continue;
    try {
      const bytes = Buffer.from(output.toString("utf8").trim(), "base64");
      if (bytes.length > 0) return bytes;
    } catch {
      // Try the next platform command.
    }
  }
  return undefined;
}

export function windowsClipboardCommands(wsl: boolean): string[] {
  return wsl
    ? [
        "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
        "pwsh.exe",
        "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        "powershell.exe",
      ]
    : ["pwsh.exe", "powershell.exe", "pwsh", "powershell"];
}

async function copyTextWithPlatformClipboard(text: string): Promise<boolean> {
  if (process.platform === "win32") {
    const command = windowsClipboardCommand(text);
    return writeToProcess(command.command, command.args, command.input);
  }

  if (process.platform === "darwin") {
    return writeToProcess("pbcopy", [], text);
  }

  return (await writeToProcess("wl-copy", [], text)) || (await writeToProcess("xclip", ["-selection", "clipboard"], text));
}

export function windowsClipboardCommand(text: string): { command: string; args: string[]; input: string } {
  const script = [
    "$base64 = [Console]::In.ReadToEnd()",
    "$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($base64))",
    "Set-Clipboard -Value $text",
  ].join("\n");
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    input: Buffer.from(text, "utf8").toString("base64"),
  };
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

function captureProcess(command: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? Buffer.concat(chunks) : undefined));
  });
}
