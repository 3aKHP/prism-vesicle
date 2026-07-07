#!/usr/bin/env bun
import { runDoctor } from "./doctor";
import { runPrompt } from "../core/agent-loop/run";
import { runPromptDump } from "./commands/prompt-dump";
import { runTui } from "../tui";

const command = process.argv[2];

switch (command) {
  case "doctor":
    await runDoctor();
    break;
  case "once": {
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
    } else {
      console.log(result.response.content);
      console.log(`\nSession: ${result.sessionPath}`);
    }
    break;
  }
  case "prompt": {
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
  case undefined:
  case "dev":
    await runTui();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Commands: doctor, once, prompt, dev");
    process.exit(1);
}
