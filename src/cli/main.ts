#!/usr/bin/env bun
import packageJson from "../../package.json";
import { isCompiledBinaryRuntime } from "./runtime";
import { parseCliInvocation } from "./args";

declare const VESICLE_COMPILED_BINARY: boolean | undefined;

// Bun's compiled single-file executable reports Bun.main from the bundled
// virtual root. Keep the invocation cwd unchanged: it is the project root for
// sessions, workspaces, and sparse project asset overrides. Runtime files use
// explicit executable/bunfs paths instead of mutating global process state.
const compiledMarker = typeof VESICLE_COMPILED_BINARY === "boolean"
  ? VESICLE_COMPILED_BINARY
  : undefined;
const isCompiledBinary = isCompiledBinaryRuntime(compiledMarker, Bun.main);

const USAGE = `Usage:
  vesicle [project-directory]
  vesicle [flags] [project-directory]
  vesicle [flags] -- [project-directory]
  vesicle <command> [args]

Flags:
  -v, --version                    print the Prism Vesicle version and exit
  -h, --help                       print this usage and exit
  -r, --resume                     open the session picker on startup
      --dangerously-skip-permissions  skip approval prompts for this process only

Commands:
  setup, launch, doctor, once, prompt, quality, debug, assets, dev`;

async function configureTreeSitterRuntime(): Promise<void> {
  // Compiled executables receive an explicit flat worker entrypoint through
  // the build-time OTUI_TREE_SITTER_WORKER_PATH define. Source/Bun-package
  // runs use the installed OpenTUI worker from node_modules instead.
  if (isCompiledBinary) return;
  const { configureTreeSitterWorkerPath } = await import("../tui/tree-sitter-runtime");
  configureTreeSitterWorkerPath();
}

async function launchProject(projectDirectory: string, dangerouslySkipPermissions: boolean, resume: boolean): Promise<void> {
  const { launchVesicleInProject } = await import("./launch");
  // Forward the process-scoped flags to the spawned child so a project-dir
  // launch preserves them: the child re-parses its own argv.
  const args: string[] = [];
  if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (resume) args.push("--resume");
  process.exitCode = await launchVesicleInProject(projectDirectory, isCompiledBinary, args);
}

async function launchProjectArgument(input: string, dangerouslySkipPermissions: boolean, resume: boolean): Promise<void> {
  const { resolveProjectDirectory } = await import("./project-target");
  await launchProject(await resolveProjectDirectory(input), dangerouslySkipPermissions, resume);
}

async function launchProjectArgumentOrReport(input: string, dangerouslySkipPermissions: boolean, resume: boolean): Promise<void> {
  try {
    await launchProjectArgument(input, dangerouslySkipPermissions, resume);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function runSetupFlow(dangerouslySkipPermissions: boolean): Promise<void> {
  if (!isCompiledBinary) {
    await import("@opentui/solid/preload");
  }
  const { runGuidedSetup } = await import("../setup");
  const result = await runGuidedSetup();
  if (result.launch && result.projectDirectory) await launchProject(result.projectDirectory, dangerouslySkipPermissions, false);
}

async function startTui(dangerouslySkipPermissions: boolean, resume: boolean): Promise<void> {
  if (!isCompiledBinary) {
    await import("@opentui/solid/preload");
  }
  await configureTreeSitterRuntime();
  const { runTui } = await import("../tui");
  await runTui({ dangerouslySkipPermissions, resume });
}

const parsed = parseCliInvocation(process.argv.slice(2));

switch (parsed.kind) {
  case "version":
    console.log(packageJson.version);
    break;
  case "help":
    console.log(USAGE);
    break;
  case "error":
    console.error(parsed.message);
    if (parsed.message.startsWith("Unknown command or project directory")) {
      console.error("Commands: setup, launch, doctor, once, prompt, quality, debug, assets, dev");
    }
    process.exitCode = 1;
    break;
  case "launch":
    // A null path is the bare `vesicle` / `vesicle --` form: start the TUI in
    // the invocation cwd, in process. An explicit path spawns into that dir.
    if (parsed.projectPath === null) {
      await startTui(parsed.dangerouslySkipPermissions, parsed.resume);
    } else {
      await launchProjectArgumentOrReport(parsed.projectPath, parsed.dangerouslySkipPermissions, parsed.resume);
    }
    break;
  case "command": {
    const { command, args, dangerouslySkipPermissions } = parsed;
    switch (command) {
      case "doctor": {
        const { runDoctor } = await import("./doctor");
        await runDoctor();
        break;
      }
      case "once": {
        const { runPrompt } = await import("../core/agent-loop/run");
        const { loadPermissionSettings } = await import("../config/permissions");
        const permissionSettings = await loadPermissionSettings();
        const input = args.join(" ").trim();
        if (!input) {
          console.error("Usage: vesicle once <prompt>");
          process.exit(1);
        }
        const result = await runPrompt({
          input,
          permission: dangerouslySkipPermissions
            ? {
              mode: "YOLO",
              dangerouslySkipPermissions: true,
              shellExecEnabled: true,
              shellInterpreter: permissionSettings.shellInterpreter,
            }
            : {
              mode: permissionSettings.defaultMode,
              shellExecEnabled: permissionSettings.shellExec,
              shellInterpreter: permissionSettings.shellInterpreter,
            },
        });
        if (result.kind === "needs_user") {
          console.log(result.assistantContent);
          console.log(`\n[gate:${result.gate.gate}] This turn needs user confirmation; the 'once' subcommand is non-interactive.`);
          console.log(`Session: ${result.sessionPath}`);
        } else if (result.kind === "needs_engine_switch") {
          console.log(result.assistantContent);
          console.log(`\n[engine-switch:${result.request.targetEngine}] This turn needs user confirmation; the 'once' subcommand is non-interactive.`);
          console.log(`Reason: ${result.request.reason}`);
          console.log(`Session: ${result.sessionPath}`);
        } else if (result.kind === "needs_user_question") {
          console.log(result.assistantContent);
          console.log(`\n[question:${result.question.header}] This turn needs user input; the 'once' subcommand is non-interactive.`);
          console.log(result.question.question);
          for (const [index, option] of result.question.options.entries()) {
            console.log(`${index + 1}. ${option.label} - ${option.description}`);
          }
          console.log(`Session: ${result.sessionPath}`);
        } else if (result.kind === "needs_permission") {
          console.log(result.assistantContent);
          console.log(`\n[permission:${result.request.toolName}] This turn needs user approval; the 'once' subcommand is non-interactive.`);
          console.log(`Session: ${result.sessionPath}`);
        } else if (result.kind === "needs_quality_decision") {
          console.log(result.assistantContent);
          console.log(`\n[quality:${result.decision.reason}] The current version still has ${result.decision.findingCount} blocking finding${result.decision.findingCount === 1 ? "" : "s"}.`);
          console.log("Resume this session in the interactive TUI to revise again, use the current version, or stop.");
          console.log(`Session: ${result.sessionPath}`);
        } else {
          console.log(result.response.content);
          console.log(`\nSession: ${result.sessionPath}`);
        }
        break;
      }
      case "prompt": {
        const { runPromptDump } = await import("./commands/prompt-dump");
        const subcommand = args[0];
        const rest = args.slice(1);
        if (subcommand === "dump") {
          await runPromptDump(rest);
        } else if (subcommand === "shape") {
          await runPromptDump([...rest, "--shape"]);
        } else {
          console.error("Usage: vesicle prompt <dump|shape> --engine <id>");
          process.exit(1);
        }
        break;
      }
      case "quality": {
        if (args[0] !== "benchmark") {
          console.error("Usage: vesicle quality benchmark --plan <path> --corpus <path> --output <jsonl> --report <json> --allow-live");
          process.exitCode = 1;
          break;
        }
        try {
          const { runQualityBenchmarkCommand } = await import("./commands/quality-benchmark");
          await runQualityBenchmarkCommand(args.slice(1));
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
        break;
      }
      case "debug": {
        if (args[0] !== "markdown-runtime") {
          console.error("Usage: vesicle debug markdown-runtime");
          process.exit(1);
        }
        await configureTreeSitterRuntime();
        const { runMarkdownRuntimeDiagnostic } = await import("../tui/markdown-runtime-diagnostic");
        const result = await runMarkdownRuntimeDiagnostic();
        console.log(JSON.stringify(result));
        if (!result.ok) process.exitCode = 1;
        break;
      }
      case "assets": {
        const { runAssetsCommand } = await import("./assets");
        try {
          await runAssetsCommand(args);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        }
        break;
      }
      case "setup": {
        await runSetupFlow(dangerouslySkipPermissions);
        break;
      }
      case "launch": {
        if (args.length > 1) {
          console.error("Usage: vesicle launch [project-directory]");
          process.exitCode = 1;
          break;
        }
        await launchProjectArgumentOrReport(args[0] ?? ".", dangerouslySkipPermissions, false);
        break;
      }
      case "dev": {
        await startTui(dangerouslySkipPermissions, false);
        break;
      }
      default:
        // Unreachable: parseCliInvocation only returns kind "command" for the
        // known commands above. Guard defensively regardless.
        console.error(`Unknown command: ${command}`);
        process.exitCode = 1;
    }
    break;
  }
}
