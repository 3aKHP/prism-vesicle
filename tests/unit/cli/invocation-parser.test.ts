import { describe, expect, test } from "bun:test";
import { parseCliInvocation } from "../../../src/cli/args";

/**
 * The typed startup-grammar parser (issues #49 Phase 1 + Phase 2). The oracle
 * is the classified `ParsedCliInvocation` result, not the previous switch
 * statement. Cases mirror the contract in
 * dev/docs/working/CLI_INVOCATION_PARSER_DESIGN.md plus bundled short options.
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

    test("-rv bundles resume into a version terminal error", () => {
      expect(parseCliInvocation(["-rv"])).toEqual({
        kind: "error",
        message: "`vesicle --version` takes no other arguments",
      });
    });
  });

  describe("default launch", () => {
    test("bare invocation starts the TUI in cwd (null path)", () => {
      expect(parseCliInvocation([])).toEqual({
        kind: "launch",
        projectPath: null,
        dangerouslySkipPermissions: false,
        resume: false,
      });
    });

    test("a lone terminator is equivalent to bare invocation", () => {
      expect(parseCliInvocation(["--"])).toEqual({
        kind: "launch",
        projectPath: null,
        dangerouslySkipPermissions: false,
        resume: false,
      });
    });

    test("an explicit path is launched", () => {
      expect(parseCliInvocation(["."])).toEqual({
        kind: "launch",
        projectPath: ".",
        dangerouslySkipPermissions: false,
        resume: false,
      });
      expect(parseCliInvocation(["novel-project"])).toEqual({
        kind: "launch",
        projectPath: "novel-project",
        dangerouslySkipPermissions: false,
        resume: false,
      });
    });
  });

  describe("option terminator", () => {
    test("a dash-prefixed path after -- is launched, not parsed as options", () => {
      expect(parseCliInvocation(["--", "-here/is/the/path"])).toEqual({
        kind: "launch",
        projectPath: "-here/is/the/path",
        dangerouslySkipPermissions: false,
        resume: false,
      });
    });

    test("-- before a flag-like token launches it literally", () => {
      expect(parseCliInvocation(["--", "--version"])).toEqual({
        kind: "launch",
        projectPath: "--version",
        dangerouslySkipPermissions: false,
        resume: false,
      });
    });

    test("-- before a command name launches it as a path, not a command", () => {
      expect(parseCliInvocation(["--", "doctor"])).toEqual({
        kind: "launch",
        projectPath: "doctor",
        dangerouslySkipPermissions: false,
        resume: false,
      });
    });

    test("the dangerous flag after -- is a literal path, not a modifier", () => {
      expect(parseCliInvocation(["--", "--dangerously-skip-permissions"])).toEqual({
        kind: "launch",
        projectPath: "--dangerously-skip-permissions",
        dangerouslySkipPermissions: false,
        resume: false,
      });
    });

    test("the dangerous flag before -- still applies while the dash path launches", () => {
      expect(parseCliInvocation(["--dangerously-skip-permissions", "--", "-here"])).toEqual({
        kind: "launch",
        projectPath: "-here",
        dangerouslySkipPermissions: true,
        resume: false,
      });
    });

    test("multiple launch operands after -- use the terminator usage error", () => {
      expect(parseCliInvocation(["--", "foo", "bar"])).toEqual({
        kind: "error",
        message: "Usage: vesicle [flags] -- [project-directory]",
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
        resume: false,
      });
    });

    test("accepted after the path", () => {
      expect(parseCliInvocation([".", "--dangerously-skip-permissions"])).toEqual({
        kind: "launch",
        projectPath: ".",
        dangerouslySkipPermissions: true,
        resume: false,
      });
    });
  });

  describe("resume launch modifier", () => {
    test("--resume opens the session picker on a bare launch", () => {
      expect(parseCliInvocation(["--resume"])).toEqual({
        kind: "launch",
        projectPath: null,
        dangerouslySkipPermissions: false,
        resume: true,
      });
    });

    test("-r is the resume short flag", () => {
      expect(parseCliInvocation(["-r"])).toEqual({
        kind: "launch",
        projectPath: null,
        dangerouslySkipPermissions: false,
        resume: true,
      });
    });

    test("--resume combines with a project path", () => {
      expect(parseCliInvocation(["--resume", "."])).toEqual({
        kind: "launch",
        projectPath: ".",
        dangerouslySkipPermissions: false,
        resume: true,
      });
      expect(parseCliInvocation(["-r", "path/to/project"])).toEqual({
        kind: "launch",
        projectPath: "path/to/project",
        dangerouslySkipPermissions: false,
        resume: true,
      });
    });

    test("--resume combines with the dangerous flag", () => {
      expect(parseCliInvocation(["--dangerously-skip-permissions", "--resume"])).toEqual({
        kind: "launch",
        projectPath: null,
        dangerouslySkipPermissions: true,
        resume: true,
      });
    });

    test("--resume with a terminal action is a usage error", () => {
      expect(parseCliInvocation(["--resume", "--version"])).toEqual({
        kind: "error",
        message: "`vesicle --version` takes no other arguments",
      });
    });

    test("--resume with a subcommand is a usage error", () => {
      expect(parseCliInvocation(["--resume", "doctor"])).toEqual({
        kind: "error",
        message: "`--resume`/`-r` only applies to launching the TUI",
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
      expect(parseCliInvocation(["skills", "list"])).toEqual({
        kind: "command",
        command: "skills",
        args: ["list"],
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

    test("a known command before -- owns the remaining argv", () => {
      expect(parseCliInvocation(["prompt", "shape", "--", "--engine"])).toEqual({
        kind: "command",
        command: "prompt",
        args: ["shape", "--", "--engine"],
        dangerouslySkipPermissions: false,
      });
      expect(parseCliInvocation(["once", "--", "hello"])).toEqual({
        kind: "command",
        command: "once",
        args: ["--", "hello"],
        dangerouslySkipPermissions: false,
      });
    });

    test("the dangerous flag is stripped from command args only before command --", () => {
      expect(parseCliInvocation(["once", "hello", "--dangerously-skip-permissions"])).toEqual({
        kind: "command",
        command: "once",
        args: ["hello"],
        dangerouslySkipPermissions: true,
      });
      expect(parseCliInvocation(["once", "--", "--dangerously-skip-permissions"])).toEqual({
        kind: "command",
        command: "once",
        args: ["--", "--dangerously-skip-permissions"],
        dangerouslySkipPermissions: false,
      });
    });

    test("a command after -- is launched as a path instead", () => {
      expect(parseCliInvocation(["--", "doctor"])).toEqual({
        kind: "launch",
        projectPath: "doctor",
        dangerouslySkipPermissions: false,
        resume: false,
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
  });

  describe("theme launch flags", () => {
    test("--dark selects the dark preference on a bare launch", () => {
      expect(parseCliInvocation(["--dark"])).toEqual({
        kind: "launch",
        projectPath: null,
        dangerouslySkipPermissions: false,
        resume: false,
        themePreference: "dark",
      });
    });

    test("--light selects the light preference on a bare launch", () => {
      expect(parseCliInvocation(["--light"])).toEqual({
        kind: "launch",
        projectPath: null,
        dangerouslySkipPermissions: false,
        resume: false,
        themePreference: "light",
      });
    });

    test("repeating the same flag is idempotent", () => {
      const dark = parseCliInvocation(["--dark", "--dark"]);
      expect(dark.kind === "launch" && dark.themePreference).toBe("dark");
      const light = parseCliInvocation(["--light", "--light"]);
      expect(light.kind === "launch" && light.themePreference).toBe("light");
    });

    test("supplying both flags is an explicit error regardless of order", () => {
      const one = parseCliInvocation(["--dark", "--light"]);
      expect(one.kind).toBe("error");
      expect(one.kind === "error" && one.message).toContain("mutually exclusive");
      const two = parseCliInvocation(["--light", "--dark"]);
      expect(two.kind).toBe("error");
    });

    test("--dark before a path launches with the dark preference", () => {
      expect(parseCliInvocation(["--dark", "."])).toEqual({
        kind: "launch",
        projectPath: ".",
        dangerouslySkipPermissions: false,
        resume: false,
        themePreference: "dark",
      });
    });

    test("--dark after a path is still recognized as a process flag", () => {
      const result = parseCliInvocation([".", "--light"]);
      expect(result.kind === "launch" && result.themePreference).toBe("light");
    });

    test("--dark -- <path> forwards the preference through the terminator", () => {
      expect(parseCliInvocation(["--dark", "--", "./project"])).toEqual({
        kind: "launch",
        projectPath: "./project",
        dangerouslySkipPermissions: false,
        resume: false,
        themePreference: "dark",
      });
    });

    test("-- before a flag makes it a literal launch operand", () => {
      const result = parseCliInvocation(["--", "--dark"]);
      expect(result).toEqual({
        kind: "launch",
        projectPath: "--dark",
        dangerouslySkipPermissions: false,
        resume: false,
      });
    });

    test("--light combines with --resume and a path", () => {
      expect(parseCliInvocation(["--light", "--resume", "."])).toEqual({
        kind: "launch",
        projectPath: ".",
        dangerouslySkipPermissions: false,
        resume: true,
        themePreference: "light",
      });
    });

    test("--dark combines with --dangerously-skip-permissions", () => {
      const result = parseCliInvocation(["--dangerously-skip-permissions", "--dark"]);
      expect(result.kind).toBe("launch");
      expect(result.kind === "launch" && result.dangerouslySkipPermissions).toBe(true);
      expect(result.kind === "launch" && result.themePreference).toBe("dark");
    });

    test("a terminal action rejects theme flags", () => {
      const versional = parseCliInvocation(["--dark", "--version"]);
      expect(versional.kind).toBe("error");
      expect(versional.kind === "error" && versional.message).toContain("takes no other arguments");
      const help = parseCliInvocation(["--light", "--help"]);
      expect(help.kind).toBe("error");
    });

    test("setup, launch, and dev accept theme flags and forward them", () => {
      expect(parseCliInvocation(["--dark", "launch", "."])).toEqual({
        kind: "command",
        command: "launch",
        args: ["."],
        dangerouslySkipPermissions: false,
        themePreference: "dark",
      });
      expect(parseCliInvocation(["launch", "--dark", "."])).toEqual({
        kind: "command",
        command: "launch",
        args: ["."],
        dangerouslySkipPermissions: false,
        themePreference: "dark",
      });
      expect(parseCliInvocation(["setup", "--light"])).toEqual({
        kind: "command",
        command: "setup",
        args: [],
        dangerouslySkipPermissions: false,
        themePreference: "light",
      });
      expect(parseCliInvocation(["dev", "--dark"])).toEqual({
        kind: "command",
        command: "dev",
        args: [],
        dangerouslySkipPermissions: false,
        themePreference: "dark",
      });
    });

    test("doctor rejects theme flags with an action-specific message", () => {
      const before = parseCliInvocation(["--dark", "doctor"]);
      expect(before.kind).toBe("error");
      expect(before.kind === "error" && before.message).toContain("doctor");
      const after = parseCliInvocation(["doctor", "--dark"]);
      expect(after.kind).toBe("error");
      expect(after.kind === "error" && after.message).toContain("doctor");
    });

    test("once, prompt, quality, assets, skills, and debug reject theme flags", () => {
      for (const command of ["once", "prompt", "quality", "assets", "skills", "debug"]) {
        const result = parseCliInvocation([command, "--dark"]);
        expect(result.kind).toBe("error");
        expect(result.kind === "error" && result.message).toContain(command);
      }
    });

    test("a literal --dark after a command's own -- is preserved in args", () => {
      const result = parseCliInvocation(["doctor", "--", "--dark"]);
      expect(result).toEqual({
        kind: "command",
        command: "doctor",
        args: ["--", "--dark"],
        dangerouslySkipPermissions: false,
      });
    });
  });
});
