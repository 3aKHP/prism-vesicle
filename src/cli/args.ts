/**
 * Top-level CLI invocation, classified into exactly one startup action.
 *
 * The parser is pure: it consumes a `string[]` argv and returns a typed result
 * without importing the TUI, providers, config, or touching the filesystem.
 * `main.ts` owns every side effect.
 */
export type ParsedCliInvocation =
  | { kind: "version" }
  | { kind: "help" }
  | {
      kind: "launch";
      // null = bare `vesicle` / `vesicle --` (start the TUI in the invocation
      // cwd, in process); a string = an explicit project path, launched by
      // spawning into that directory. The distinction preserves the pre-parser
      // split between in-process TUI startup and project-dir spawning.
      projectPath: string | null;
      dangerouslySkipPermissions: boolean;
      // Open the session picker on startup (equivalent to `/resume` with no
      // argument). Only meaningful for launch; never set for commands.
      resume: boolean;
    }
  | {
      kind: "command";
      command: string;
      args: string[];
      dangerouslySkipPermissions: boolean;
    }
  | { kind: "error"; message: string };

const DANGEROUS_FLAG = "--dangerously-skip-permissions";

// Subcommands that own their remaining argv once recognized before any `--`.
const KNOWN_COMMANDS = new Set([
  "setup",
  "launch",
  "doctor",
  "once",
  "prompt",
  "quality",
  "debug",
  "assets",
  "dev",
]);

const error = (message: string): ParsedCliInvocation => ({ kind: "error", message });

/**
 * Parse Vesicle's top-level startup grammar.
 *
 *   vesicle                       -> bare TUI in the invocation cwd
 *   vesicle <path>                -> launch a project path
 *   vesicle -- <path>             -> launch a path (dash-prefixed names safe)
 *   vesicle <command> [args...]   -> subcommand dispatch
 *   vesicle --version | -v        -> print version and exit 0
 *   vesicle --help | -h           -> print usage and exit 0
 *   vesicle --resume | -r [path]  -> launch and open the session picker
 *   vesicle -vhr                  -> bundled boolean short options
 *   --dangerously-skip-permissions -> process-scoped, accepted anywhere before `--`
 *
 * Short options are always boolean and never take a value; options that need a
 * value use the long form (`--name value`). A lone `--` ends top-level option
 * parsing. After it, every token is a launch positional, so
 * `vesicle -- --version` launches a project literally named `--version`.
 */
export function parseCliInvocation(argv: string[]): ParsedCliInvocation {
  // `--` ends top-level option parsing. Only the slice before it is scanned for
  // flags and the known-command shortcut; after it every token is a path.
  const terminator = argv.indexOf("--");
  const hasTerminator = terminator >= 0;
  const before = hasTerminator ? argv.slice(0, terminator) : argv;
  const after = hasTerminator ? argv.slice(terminator + 1) : [];

  // The dangerous flag is process-scoped and position-agnostic, but only before
  // the terminator: after `--` it is an ordinary positional token (see
  // `vesicle -- --dangerously-skip-permissions` in the design contract).
  let dangerouslySkipPermissions = false;
  const tokens: string[] = [];
  for (const token of before) {
    if (token === DANGEROUS_FLAG) {
      dangerouslySkipPermissions = true;
      continue;
    }
    tokens.push(token);
  }

  // Scan leading global options until the first positional token.
  let version = false;
  let help = false;
  let resume = false;
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--version") {
      version = true;
      i++;
      continue;
    }
    if (token === "--help") {
      help = true;
      i++;
      continue;
    }
    if (token === "--resume") {
      resume = true;
      i++;
      continue;
    }
    if (token.startsWith("--")) {
      return error(`Unknown option: ${token}`);
    }
    if (token.length > 1 && token.startsWith("-")) {
      // Bundled boolean short options, e.g. `-vhr`. Each character must be a
      // known boolean short option; Vesicle short options never take a value.
      for (const flag of token.slice(1)) {
        if (flag === "v") version = true;
        else if (flag === "h") help = true;
        else if (flag === "r") resume = true;
        else return error(`Unknown option: -${flag}`);
      }
      i++;
      continue;
    }
    break; // first positional (or a lone "-")
  }

  // Terminal global actions reject any other token and any launch modifier.
  if (version || help) {
    if (dangerouslySkipPermissions || resume || i < tokens.length || after.length > 0) {
      return error(
        version
          ? "`vesicle --version` takes no other arguments"
          : "`vesicle --help` takes no other arguments",
      );
    }
    return version ? { kind: "version" } : { kind: "help" };
  }

  const prePositionals = tokens.slice(i);

  // A known command recognized before the terminator owns its remaining argv
  // (including any later `--`, which the subcommand may interpret itself).
  // `--resume` is a launch modifier and does not apply to subcommands.
  if (!hasTerminator && prePositionals.length > 0 && KNOWN_COMMANDS.has(prePositionals[0])) {
    if (resume) {
      return error("`--resume`/`-r` only applies to launching the TUI");
    }
    return {
      kind: "command",
      command: prePositionals[0],
      args: prePositionals.slice(1),
      dangerouslySkipPermissions,
    };
  }

  // Launch path. With a terminator, only the post-terminator tokens are the
  // path; any pre-terminator positional here is an ambiguous mixed invocation.
  if (hasTerminator && prePositionals.length > 0) {
    return error("Usage: vesicle [flags] -- [project-directory]");
  }
  const positionals = hasTerminator ? after : prePositionals;
  if (positionals.length > 1) {
    return error(`Unknown command or project directory: ${positionals[0]}`);
  }

  return {
    kind: "launch",
    projectPath: positionals[0] ?? null,
    dangerouslySkipPermissions,
    resume,
  };
}
