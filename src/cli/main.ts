#!/usr/bin/env bun
import { isCompiledBinaryRuntime } from "./runtime";

declare const VESICLE_COMPILED_BINARY: boolean | undefined;

// Bun's compiled single-file executable reports Bun.main from the bundled
// virtual root. Keep the invocation cwd unchanged: it is the project root for
// sessions, workspaces, and sparse project asset overrides. Runtime files use
// explicit executable/bunfs paths instead of mutating global process state.
const compiledMarker = typeof VESICLE_COMPILED_BINARY === "boolean"
  ? VESICLE_COMPILED_BINARY
  : undefined;
const isCompiledBinary = isCompiledBinaryRuntime(compiledMarker, Bun.main);

const command = process.argv[2];

async function configureTreeSitterRuntime(): Promise<void> {
  // Compiled executables receive an explicit flat worker entrypoint through
  // the build-time OTUI_TREE_SITTER_WORKER_PATH define. Source/Bun-package
  // runs use the installed OpenTUI worker from node_modules instead.
  if (isCompiledBinary) return;
  const { configureTreeSitterWorkerPath } = await import("../tui/tree-sitter-runtime");
  configureTreeSitterWorkerPath();
}

switch (command) {
  case "doctor": {
    const { runDoctor } = await import("./doctor");
    await runDoctor();
    break;
  }
  case "once": {
    const { runPrompt } = await import("../core/agent-loop/run");
    const input = process.argv.slice(3).join(" ").trim();
    if (!input) {
      console.error("Usage: vesicle once <prompt>");
      process.exit(1);
    }
    const result = await runPrompt({ input });
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
    } else {
      console.log(result.response.content);
      console.log(`\nSession: ${result.sessionPath}`);
    }
    break;
  }
  case "prompt": {
    const { runPromptDump } = await import("./commands/prompt-dump");
    const subcommand = process.argv[3];
    const rest = process.argv.slice(4);
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
  case "debug": {
    if (process.argv[3] !== "markdown-runtime") {
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
    await runAssetsCommand(process.argv.slice(3));
    break;
  }
  case undefined:
  case "dev": {
    if (!isCompiledBinary) {
      await import("@opentui/solid/preload");
    }
    await configureTreeSitterRuntime();
    const { runTui } = await import("../tui");
    await runTui();
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Commands: doctor, once, prompt, debug, assets, dev");
    process.exit(1);
}
