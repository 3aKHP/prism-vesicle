# Command Queue

This document defines how TUI slash commands behave while the Agent Loop is busy. It applies to command definitions under `src/tui/commands/` and to the shared composer queue.

## Registration Contract

`builtinCommands` is the command registry used by matching, completion, dispatch, and busy-turn scheduling. Every `Command` must declare `busyBehavior` beside its existing execution metadata. Do not add a second command-name whitelist to a controller or queue implementation.

```ts
type CommandBusyBehavior =
  | { kind: "immediate" }
  | { kind: "queue"; boundary: "tool-round" | "agent-loop" }
  | { kind: "reject"; reason: string };

type CommandBusyBehaviorResolver =
  | CommandBusyBehavior
  | ((args: string) => CommandBusyBehavior);
```

Use a literal for commands whose behavior is uniform. Use an argument resolver only when one command name includes materially different operations, such as a read-only status form and a mutating configuration form. The resolver receives normalized command arguments and must remain synchronous and side-effect free.

There is deliberately no default. A missing declaration is a type error, so adding a command requires an explicit scheduling decision without changing the shared scheduler.

## Behaviors

| Behavior | Contract |
|---|---|
| `immediate` | Execute while the Agent Loop continues. Use only for host actions that do not race with the current tool round or invalidate the active loop snapshot. |
| `queue: tool-round` | Execute after the current complete tool round and before queued user messages are injected into the next provider request. |
| `queue: agent-loop` | Execute after the active Agent Loop reaches a terminal or locally resolved state and the TUI is idle. |
| `reject` | Keep the draft and display the registered reason. Reserve this for operations whose intent cannot safely become stale or be replayed later. |

Provider, model, engine, effort, permission, and quality settings are snapshotted when an Agent Loop starts. Their mutations therefore use the Agent Loop boundary; running those handlers at a tool boundary would not reconfigure the already active loop.

Artifact preview and validation use the tool-round boundary so they observe a complete mutation round. Session-changing commands use the Agent Loop boundary and clear the remaining shared input queue when they actually switch or reset the session.

## Current Mapping

| Commands | Busy behavior |
|---|---|
| `/help`, `/context`, `/reasoning` | immediate |
| `/engine`, `/effort`, `/permissions` without arguments | immediate |
| `/quality status` | immediate |
| `/agents` list, inspect, or stop | immediate |
| `/artifact`, `/validate` | queue at tool-round boundary |
| `/model`, `/compact`, `/stage`, `/new`, `/resume`, `/rewind` | queue at Agent Loop boundary |
| engine, effort, permission, and quality mutations | queue at Agent Loop boundary |
| `/agents retry` | queue at Agent Loop boundary |

## Queue And Execution Rules

Messages and deferred commands share one in-memory composer queue and one visible FIFO preview. Up with an empty busy composer retrieves the most recently queued item for editing.

The Agent Loop removes ordinary messages at its input boundary and preserves their relative order. The command scheduler separately preserves command FIFO: an Agent Loop-boundary command blocks later tool-round commands from overtaking it. At an idle boundary, the TUI processes the next remaining mixed input item.

Queued commands are stored with their canonical command name, normalized arguments, raw display text, and resolved boundary. Execution still goes through the normal command dispatcher and handler. Unknown commands are never queued; they report their normal error immediately.

Execute one idle item at a time and re-check busy, picker, modal, and session state after every command. A command that opens a picker pauses queue draining until that interaction closes. A session reset or switch clears remaining queued input rather than applying stale work to a different session.

Escape does not grant a command a different capability. When the user interrupts the current provider or tool operation, Vesicle repairs the interrupted conversation and immediately processes the next queued input under normal command dispatch.

## Adding A Command

1. Add the command to `builtinCommands` with `name`, `description`, `busyBehavior`, and `run`.
2. Add `aliases`, `usage`, or `completion` only when the command needs them.
3. Choose the earliest boundary that is actually safe. Do not use `immediate` merely to make a command feel responsive.
4. If behavior depends on arguments, keep the resolver limited to classification and keep validation in `run`.
5. Add focused coverage for the registered classification and for any queue boundary or rejection behavior that is not already covered by the shared scheduler tests.

## Verification

Run:

```bash
bun run lint
bun run typecheck
bun test
bun run doctor
git diff --check
```

For changes to tool-round scheduling or Escape behavior, also exercise a real TUI turn when practical.
