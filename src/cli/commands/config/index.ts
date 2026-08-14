// config CLI dispatch — routes subcommands to domain modules.
// Designed for both interactive use and Skill-script invocation: all write
// operations output a single JSON envelope on stdout; errors go to stderr.

import { runShow, runPath, runValidate } from "./show";
import { runSet } from "./set";
import { runEnvSetEmpty, runEnvSetProxy, runEnvRemove } from "./env";
import { runAddProvider } from "./add";
import { runAddModel } from "./add-model";
import { runAddMcp } from "./add-mcp";
import { runRemoveModel, runRemoveProvider } from "./remove";
import { runUnset } from "./unset";

export async function runConfigCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (command === "path" && args.length === 1) {
    runPath();
    return;
  }
  if (command === "show" && args.length === 2) {
    await runShow(args[1]!);
    return;
  }
  if (command === "set" && args.length >= 4) {
    await runSet(args.slice(1));
    return;
  }
  if (command === "add-provider" && args.length >= 2) {
    await runAddProvider(args.slice(1));
    return;
  }
  if (command === "add-model" && args.length >= 2) {
    await runAddModel(args.slice(1));
    return;
  }
  if (command === "add-mcp" && args.length >= 2) {
    await runAddMcp(args.slice(1));
    return;
  }
  if (command === "remove-model" && args.length === 3) {
    await runRemoveModel(args.slice(1));
    return;
  }
  if (command === "remove-provider" && args.length === 2) {
    await runRemoveProvider(args.slice(1));
    return;
  }
  if (command === "unset" && args.length === 3) {
    await runUnset(args.slice(1));
    return;
  }
  if (command === "env-set-empty" && args.length === 2) {
    await runEnvSetEmpty(args[1]!);
    return;
  }
  if (command === "env-set-proxy" && args.length === 2) {
    await runEnvSetProxy(args[1]!);
    return;
  }
  if (command === "env-remove" && args.length === 2) {
    await runEnvRemove(args[1]!);
    return;
  }
  if (command === "validate" && args.length === 1) {
    await runValidate();
    return;
  }
  printUsage();
  process.exitCode = 1;
}

function printUsage(): void {
  console.error("Usage:");
  console.error("  vesicle config path");
  console.error("  vesicle config show <providers|env|permissions|mcp|quality|settings|preferences>");
  console.error("  vesicle config set <file> <key> <value>");
  console.error("  vesicle config add-provider --json '<entry>'");
  console.error("  vesicle config add-model <provider-id> --json '<entry>'");
  console.error("  vesicle config add-mcp --json '<entry>'");
  console.error("  vesicle config remove-model <provider-id> <model-id>");
  console.error("  vesicle config remove-provider <provider-id>");
  console.error("  vesicle config unset <file> <key>");
  console.error("  vesicle config env-set-empty <KEY>");
  console.error("  vesicle config env-set-proxy <URL>");
  console.error("  vesicle config env-remove <KEY>");
  console.error("  vesicle config validate");
}
