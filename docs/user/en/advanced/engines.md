# Choose a Prism Engine

English | [简体中文](../../zh-CN/advanced/engines.md)

An Engine determines the workflow prompt, visible tools, validators, and confirmation gates. It is not the model: `/model` changes provider/model, while `/engine` changes workflow. Start in the TUI with:

```text
/engine
```

The `*` marks the active Engine. Except for Stage, switch with `/engine <id>`. Success says `Engine switched to <id>. Future turns will use that profile.` Switching affects **future turns** and does not start a task by itself.

## Seven bundled Engines

| id | Best for | Minimum input | Typical output/feedback |
|---|---|---|---|
| `etl` | Build character cards, scenario cards, expansion material, or lite persona prompts from sources | Notes under `source_materials/` or existing cards | Blueprint and phase gates; artifacts usually under `workspace/` |
| `runtime` | Turn-by-turn file-backed simulation with a character and scenario card | Two cards plus a session-log path under `test_runs/` | Appends a three-part response to the log and opens a runtime gate each turn |
| `evaluate` | Audit cards, logs, expansion material, or long-form continuity | A precise target; sources under `source_materials/` or web research when needed | `reports/audit_<target>.md` plus inline PASS/CONDITIONAL/FAIL; reports rather than edits by default |
| `weaver` | Write one chapter in one Engine, creating ordered Scene Shards and compiling them | Character card, scenario card, `outline.md`, and `story_bible.md` | `novels/<project>/chapters/Chapter_XX/Scene_NNN.md` plus a compiled chapter |
| `weaver-orch` | Orchestrate long-form planning, sequential Scene Writer delegation, Story Bible sync, and independent audit | Cards; a new project can begin from a goal, while an existing one needs outline/story bible | Project skeleton, scenes, chapter, Story Bible, audit report, and decision points |
| `dyad` | Have the model play both user and character entities to generate multi-turn simulation data | Character + scenario card; optional simulation plan | `test_runs/<name>_simulation_plan.md` and `_dyad_log.md` |
| `stage` | Continuous narrative where you personally play one side | One character card + one scenario card | Direct continuation with no tools and no gates. Must use `/stage`, not ordinary `/engine stage` |

## First switch example: Evaluate

Make sure `workspace/` contains a target, then run:

```text
/engine evaluate
```

After the success notice, send:

> Read-only audit workspace/character-card.md against facts in source_materials/ and the Module A structure. Write reports/audit_character.md. Do not edit the reviewed file.

Success returns a verdict and report path. Open it with `/artifact reports/audit_character.md`. `/validate` is a local structural check, not the same as an Evaluate model audit, which incurs a provider request.

## Compact before switching a long conversation

A direct switch keeps current history. When the old workflow is long:

```text
/engine evaluate --summary Preserve card paths, confirmed facts, and unresolved questions
```

Success includes `with summarized context`. The original transcript remains, while provider context continues from a portable compact checkpoint. Summarization also calls the current provider. If it fails, the UI must not pretend a summarized switch succeeded; try `/compact` separately or shorten the session.

## Stage's special entrypoint

Stage must freeze two cards and its opening context, so `/engine stage` refuses and directs you to:

```text
/stage workspace/character-card.md workspace/scenario-card.md
```

See [Stage consumer engine](./stage.md) for details and recovery. Use `/new` to leave Stage and return to a fresh default ETL session.

## If you chose incorrectly

- `Unknown engine`: run `/engine` and copy an id, not the display name.
- The Engine changed but “nothing started”: switching only selects a workflow. Send a normal message with input paths and a goal.
- Tools or gates do not match expectations: run `/engine` to confirm the star, then `vesicle prompt shape --engine <id>` to inspect effective assets. Use `/new` if old-session identity is suspect.
- A Weaver-Orch Agent fails: use the recoverable decision shown by the UI. Do not treat a child completion claim as proof of a written artifact; inspect the actual file in Workspace.

## Checklist

- [ ] You can distinguish `/model` from `/engine`.
- [ ] You used `/engine` to see the active id and completed one non-Stage switch.
- [ ] You know Stage must use `/stage`.
- [ ] You can choose one entrypoint among ETL, Runtime, Evaluate, Weaver, Weaver-Orch, Dyad, and Stage for a concrete task.
