# Command Argument Completion

This document defines the extension contract for slash-command argument completion. It applies to user-facing TUI commands under `src/tui/commands/`.

## Ownership

Command execution remains in `commands/builtin.ts`. A command that has completable arguments declares an optional `completion` property beside its `name`, `usage`, and `run` handler. The completion property owns only the editable command grammar and how a selected candidate rebuilds the composer draft.

Every command also declares its busy-turn scheduling behavior in the same registry entry. See [Command Queue](./COMMAND_QUEUE.md). Completion must not infer or override that behavior.

The shared controller in `command-completion-controller.ts` owns popup rendering state, filtering, selection, keyboard handling, async loading, and stale-result protection. It must not gain command-name branches. Do not infer completion behavior by parsing `usage`; `usage` is display metadata, not an executable grammar.

The public types are in `commands/types.ts`:

```ts
type CommandCompletion = {
  resolve: (
    draft: string,
    context: CommandCompletionContext,
  ) => CommandArgumentCompletion | null;
};
```

Return `null` when the command has no completable position at the current cursor text. Otherwise return one `CommandArgumentCompletion` with these fields:

| Field | Contract |
| --- | --- |
| `sourceKey` | Stable while the user only changes the filter query. Include prior selected values when they change the candidate source. |
| `selectionKey` | Changes whenever the editable draft changes so the selected row resets to zero. |
| `query` | The text used by the shared prefix-first matcher. |
| `hint` | Short source/stage name rendered below the popup. |
| `items` | Immediate `OptionItem[]` candidates, or an async loader for runtime data. |
| `complete` | Returns the complete, canonical composer draft for a selected candidate. |

The resolver receives a host-owned `CommandCompletionContext`. It exposes configured provider data, the active provider, refreshed artifact and session stores, active Agent rows, and the project root. Add a context capability only when a new command needs a distinct host-owned source; do not read component signals or project files directly from a command definition.

## Adding A Command

1. Implement or update the command's `run` handler in `builtin.ts`. The handler remains the execution authority and validates its input independently.
2. Add a `completion` property if the command has finite or runtime-discoverable arguments.
3. Parse only that command's grammar in `resolve`. Preserve accepted aliases as input, but emit the canonical command and canonical argument values from `complete`.
4. Use an existing completion factory when it matches the command. Examples include `fixedCommandCompletion(...)` and `artifactCommandCompletion(...)`.
5. Add focused tests for every completion stage, selected draft, empty source, and applicable path or runtime-state boundary.

A small fixed-value command can use the existing factory:

```ts
{
  name: "permissions",
  usage: "/permissions [MANUAL|INERTIA|MOMENTUM|YOLO]",
  completion: fixedCommandCompletion("permissions"),
  async run(ctx, args, raw) {
    // Execution and validation stay here.
  },
}
```

For a new grammar, keep the parser and builder close to the command-specific completion module. This abbreviated shape shows the required separation:

```ts
const exampleCompletion: CommandCompletion = {
  resolve(draft, context) {
    const query = draft.slice("/example ".length);
    if (!draft.startsWith("/example ")) return null;

    return {
      sourceKey: "example:target",
      selectionKey: `example:target:${draft}`,
      query,
      hint: "targets",
      items: async () => loadTargets(context),
      complete: (item) => `/example ${item.id}`,
    };
  },
};
```

`complete` controls whether the next stage opens. Return a trailing space after selecting an argument that leads to another stage, such as a provider before its model. Return an executable draft for a terminal argument. Quote project-relative arguments when the command grammar accepts spaces, using the same tokenization rules as its execution handler.

## Candidate Sources

Static and dynamic candidates use the same contract.

- Fixed values must come from the runtime enum or canonical registry, not a duplicate literal list.
- Provider and model values come from the loaded provider registry. Preserve `/model`'s provider-first flow and active-provider shorthand behavior when changing it.
- Artifact and session candidates use their existing refresh/list functions. Display a useful detail row, but complete to a stable project-relative path or session id rather than a transient list number.
- Agent candidates come from the active parent session's Agent state.
- Filesystem candidates require a core-layer, guarded enumerator. TUI completion must never expose absolute paths, `..` escapes, or symbolic-link targets. Revalidate the selected path at command execution; completion is a convenience, not authorization.

Async candidate loaders are entered once per `sourceKey`. The controller filters the loaded list locally as `query` changes. It clears old candidates while loading and ignores a result after the user moves to another grammar stage or cancels the draft. A dynamic loader must be bounded and should return an empty list rather than inventing a fallback candidate.

## Compatibility And Interaction

The shared popup owns Up/Down, Ctrl+P/Ctrl+N, Tab, Enter, and Escape. A command completion must not add its own keyboard handling.

- Tab applies the selected canonical draft without executing the command.
- Enter applies an incomplete draft, or executes when the current draft already equals the selected terminal draft.
- Escape clears the composer through the shared controller.
- Enter submits the completed command through its registered busy-turn behavior. Immediate commands run while the Agent Loop continues; deferred commands enter the shared composer queue; rejected commands keep their draft.
- Empty candidate lists remain a valid open popup state with a neutral selection.

Keep `/model` behavior compatible: the first visible stage remains provider-first, selecting a provider appends a space for provider-scoped model completion, and a single argument that is not a provider id may complete to a model of the active provider.

## Tests And Verification

Add or extend tests in `tests/tui-command-completion.test.ts` and the command-specific test file. Cover the command registration, each finite or dynamic stage, canonical draft construction, active-provider/provider-scoped model paths where applicable, empty results, and guarded project-relative paths.

The current OpenTUI/Solid test runtime does not replay all client-side effects reliably. Keep focused pure resolver tests for grammar and source behavior, and use a narrow static guard for controller cancellation/keyboard invariants when a client effect cannot be exercised. Do not replace a feasible behavioral test with a static source assertion.

Run the normal TUI verification set after changing this contract:

```bash
bun run typecheck
bun test
bun run doctor
git diff --check
```
