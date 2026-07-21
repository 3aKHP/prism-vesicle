import { describe, expect, test } from "bun:test";
import { parseCliInvocation } from "../../../src/cli/args";

/**
 * The typed startup-grammar parser (issue #49 Phase 1). The oracle is the
 * classified `ParsedCliInvocation` result, not the previous switch statement.
 * Cases mirror the contract in dev/docs/working/CLI_INVOCATION_PARSER_DESIGN.md
 * plus bundled short options and the phase-1 non-support of `--resume`.
 */
describe("CLI invocation parser", () => {
  describe("terminal global actions", () => {
    test("--version is a terminal action", () => {
      expect(parseCliInvocation(["--version"])).toEqual({ kind: "version" });
    });

    test("-v is the version short flag", () => {
      expect(parseCliInvocation(["-v"])).toEqual({ kind: "version" });
    });

    test("--help is a terminal action", () => {
      expect(parseCliInvocation(["--help"])).toEqual({ kind: "help" });
    });

    test("-h is the help short flag", () => {
      expect(parseCliInvocation(["-h"])).toEqual({ kind: "help" });
    });

    test("a terminal action rejects an extra project path", () => {
      expect(parseCliInvocation(["--version", "."])).toEqual({
        kind: "error",
        message: "`vesicle --version` takes no other arguments",
      });
    });

    test("--version combined with the dangerous flag is a usage error", () => {
      expect(parseCliInvocation(["--dangerously-skip-permissions", "--version"])).toEqual({
        kind: "error",
        message: "`vesicle --version` takes no other arguments",
      });
    });
  });

  describe("bundled short options", () => {
    test("-vh expands into the version terminal action", () => {
      expect(parseCliInvocation(["-vh"])).toEqual({ kind: "version" });
    });

    test("-hv resolves to version when both terminals are set", () => {
      expect(parseCliInvocation(["-hv"])).toEqual({ kind: "version" });
    });

    test("an unknown short flag inside a bundle is reported", () => {
      expect(parseCliInvocation(["-vx"])).toEqual({
        kind: "error",
        message: "Unknown option: -x",
      });
    });
  });

  describe("default launch", () => {
    test("bare invocation starts the TUI in cwd (null path)", () => {
      expect(parseCliInvocation([])).toEqual({
        kind: "launch",
        projectPath: null,
        dangerouslySkipPermissions: false,
      });
    });

    test("a lone terminator is equivalent to bare invocation", () => {
      expect(parseCliInvocation(["--"])).toEqual({
        kind: "launch",
        projectPath: null,
        dangerouslySkipPermissions: false,
      });
    });

    test("an explicit path is launched", () => {
      expect(parseCliInvocation(["."])).toEqual({
        kind: "launch",
        projectPath: ".",
        dangerouslySkipPermissions: false,
      });
      expect(parseCliInvocation(["novel-project"])).toEqual({
        kind: "launch",
        projectPath: "novel-project",
        dangerouslySkipPermissions: false,
      });
    });
  });

  describe("option terminator", () => {
    test("a dash-prefixed path after -- is launched, not parsed as options", () => {
      expect(parseCliInvocation(["--", "-here/is/the/path"])).toEqual({
        kind: "launch",
        projectPath: "-here/is/the/path",
        dangerouslySkipPermissions: false,
      });
    });

    test("-- before a flag-like token launches it literally", () => {
      expect(parseCliInvocation(["--", "--version"])).toEqual({
        kind: "launch",
        projectPath: "--version",
        dangerouslySkipPermissions: false,
      });
    });

    test("-- before a command name launches it as a path, not a command", () => {
      expect(parseCliInvocation(["--", "doctor"])).toEqual({
        kind: "launch",
        projectPath: "doctor",
        dangerouslySkipPermissions: false,
      });
    });

    test("the dangerous flag after -- is a literal path, not a modifier", () => {
      expect(parseCliInvocation(["--", "--dangerously-skip-permissions"])).toEqual({
        kind: "launch",
        projectPath: "--dangerously-skip-permissions",
        dangerouslySkipPermissions: false,
      });
    });

    test("the dangerous flag before -- still applies while the dash path launches", () => {
      expect(parseCliInvocation(["--dangerously-skip-permissions", "--", "-here"])).toEqual({
        kind: "launch",
        projectPath: "-here",
        dangerouslySkipPermissions: true,
      });
    });

    test("a positional both before and after -- is an ambiguous usage error", () => {
      expect(parseCliInvocation(["foo", "--", "bar"])).toEqual({
        kind: "error",
        message: "Usage: vesicle [flags] -- [project-directory]",
      });
    });
  });

  describe("dangerous flag", () => {
    test("accepted before the path", () => {
      expect(parseCliInvocation(["--dangerously-skip-permissions", "."])).toEqual({
        kind: "launch",
        projectPath: ".",
        dangerouslySkipPermissions: true,
      });
    });

    test("accepted after the path", () => {
      expect(parseCliInvocation([".", "--dangerously-skip-permissions"])).toEqual({
        kind: "launch",
        projectPath: ".",
        dangerouslySkipPermissions: true,
      });
    });
  });

  describe("command dispatch", () => {
    test("a known command owns its remaining argv", () => {
      expect(parseCliInvocation(["doctor"])).toEqual({
        kind: "command",
        command: "doctor",
        args: [],
        dangerouslySkipPermissions: false,
      });
      expect(parseCliInvocation(["prompt", "shape", "--engine", "etl"])).toEqual({
        kind: "command",
        command: "prompt",
        args: ["shape", "--engine", "etl"],
        dangerouslySkipPermissions: false,
      });
    });

    test("the launch command keeps an explicit dash-prefixed path", () => {
      expect(parseCliInvocation(["launch", "./-v"])).toEqual({
        kind: "command",
        command: "launch",
        args: ["./-v"],
        dangerouslySkipPermissions: false,
      });
    });

    test("a command after -- is launched as a path instead", () => {
      expect(parseCliInvocation(["--", "doctor"])).toEqual({
        kind: "launch",
        projectPath: "doctor",
        dangerouslySkipPermissions: false,
      });
    });
  });

  describe("errors", () => {
    test("unknown long option", () => {
      expect(parseCliInvocation(["--unknown"])).toEqual({
        kind: "error",
        message: "Unknown option: --unknown",
      });
    });

    test("more than one launch positional keeps the unknown-command wording", () => {
      expect(parseCliInvocation(["frobnicate", "extra"])).toEqual({
        kind: "error",
        message: "Unknown command or project directory: frobnicate",
      });
    });

    test("resume is not supported in phase 1", () => {
      expect(parseCliInvocation(["--resume"])).toEqual({
        kind: "error",
        message: "Unknown option: --resume",
      });
    });
  });
});
