import { describe, expect, test } from "bun:test";
import { windowsClipboardCommand, windowsClipboardCommands } from "../../../src/tui/clipboard";

describe("clipboard", () => {
  test("windows clipboard command transports Unicode text through UTF-8 base64", () => {
    const text = "中文复制\n洛天依";
    const command = windowsClipboardCommand(text);

    expect(command.command).toBe("powershell.exe");
    expect(command.args).toContain("-EncodedCommand");
    expect(command.input).toBe(Buffer.from(text, "utf8").toString("base64"));
    expect(command.input).not.toContain("中文");

    const encodedCommand = command.args[command.args.length - 1];
    const script = Buffer.from(encodedCommand, "base64").toString("utf16le");
    expect(script).toContain("[Text.Encoding]::UTF8.GetString");
    expect(script).toContain("Set-Clipboard -Value $text");
  });

  test("WSL image paste prefers the standard PowerShell 7 path", () => {
    expect(windowsClipboardCommands(true)).toEqual([
      "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
      "pwsh.exe",
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      "powershell.exe",
    ]);
  });
});
