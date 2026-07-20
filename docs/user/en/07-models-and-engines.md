# 07 — Models and Prism Engines

[← Previous: First conversation](./06-first-conversation.md) | [Manual index](./README.md) | [简体中文](../zh-CN/07-models-and-engines.md) | [Next: Sessions and resume →](./08-sessions-and-resume.md)

## What You Will Accomplish

You will understand the difference between a provider, a model, and a Prism engine; inspect the configured choices; and switch models or engines without confusing their responsibilities.

**Estimated time:** 15 minutes

**Prerequisites:** Chapters 00–06 and a working Vesicle installation

## Four Different Layers

Vesicle brings four separate choices together:

| Layer | What it controls | Example |
|---|---|---|
| Provider | The remote service, endpoint, account, and API key | DeepSeek |
| Model | The specific AI model, capabilities, limits, and usage price | `deepseek-v4-flash` |
| Prism engine | The workflow instructions, tools, validators, and confirmation gates | `etl` |
| Agent Profile | A specialized delegated worker with its own prompt, tools, context policy, and execution default | `explore` |

Changing the model changes which AI performs future requests. Changing the Prism engine changes what that AI is instructed to do. An engine is not a model, and switching engines does not move your account to another provider.

An Agent Profile is also not an engine. The active engine remains responsible for the overall workflow and may start several specialized SubAgents—for example, ETL can use Explore for a large source collection, Weaver-Orch can use Plan before dispatching writers, and Evaluate can run several independent reviewers in parallel.

## Inspect Agent Profiles And Child Work

Submit:

```text
/agents
```

Vesicle lists the bundled Explore, Plan, Research, Reviewer, and General profiles plus project or user overrides under `assets/agents/`. It also shows children owned by the current session. Each child receives a short handle such as `explore-1`; the longer UUID used for storage and recovery stays internal.

A foreground child pauses only the parent model loop; the TUI stays responsive and its dedicated Agent card shows progress until the result returns in the same turn. A background child lets the parent continue immediately. Its card, the header, and the Workspace sidebar keep the work visible as it moves from running to ready, integrating, and integrated. When one or more background children finish, Vesicle durably records their results and automatically continues the idle parent Engine—no polling is required.

Inspect one child in detail:

```text
/agents explore-1
```

To interrupt a running child:

```text
/agents stop explore-1
```

Typing `/agents ` opens handle completion, including only queued or running children after `/agents stop `. Existing sessions that contain older UUID-style ids remain compatible, but new tool results and commands use short handles.

Agent Profiles are runtime assets, so advanced users and Harness Packs can add custom roles without adding them to the seven-engine list.

If background-result integration exhausts the provider's normal retries, Vesicle keeps the durable result ready instead of starting an unbounded charged retry loop. Submit `/agents retry` to retry that delivery explicitly.

## Inspect the Active Provider and Model

The TUI footer shows the active provider and model. You can also open the model picker by submitting:

```text
/model
```

The picker has two steps:

1. Use Up and Down to choose a configured provider, then press Enter.
2. Choose one of that provider's configured models, then press Enter again.

Ctrl+P and Ctrl+N are alternatives to Up and Down. Escape returns from the model step to the provider step; pressing Escape again closes the picker without changing anything.

The Chapter 04 beginner configuration contains only one provider and one model, so the picker may have only one choice at each step. Later, after additional profiles are added to `providers.yaml`, the same picker remains the guided way to switch.

Opening or using the picker is a local host action. It does not send a prompt or spend model tokens. The selected provider and model are used by future provider turns and are recorded in an existing session.

## Direct Model Commands

The interactive picker is recommended for beginners. Vesicle also accepts direct forms:

```text
/model deepseek
/model deepseek deepseek-v4-flash
```

`/model <provider>` selects that provider's configured default model. `/model <provider> <model>` selects an exact configured pair. A single argument that is not a provider id is treated as a model inside the active provider.

Vesicle refuses providers and models that are not listed in `providers.yaml`. Changing a model id in a command does not add it to the configuration.

## Inspect the Prism Engines

Submit:

```text
/engine
```

Vesicle lists the bundled engines and marks the active one with `*`:

| Engine id | Intended role |
|---|---|
| `etl` | Turn source material into structured cards and persona prompts |
| `runtime` | Run turn-by-turn character interaction |
| `evaluate` | Audit artifacts and continuity |
| `weaver` | Draft scene shards |
| `weaver-orch` | Coordinate long-form writing |
| `dyad` | Work with two-entity simulation data |
| `stage` | Run a continuous, character-driven narrative from prepared cards |

The current alpha has different levels of validation and confirmation support across these engines. `STATUS.md` is the authority for current limitations; do not assume that every engine has the same validators or guided workflow.

## Start a Stage Session

Stage is the one engine that cannot be entered through `/engine stage`. It needs a prepared Module A character card and Module B scenario card before the session exists, so start it with:

```text
/stage workspace/character.md workspace/scenario.md
```

Both paths must be project-relative and under an approved project root. Vesicle freezes the supplied character card and visible scenario opening before your first action. It may show a short compatibility warning for missing or unusual card structure, but that warning does not certify, rewrite, or reject your creative work. Only an unreadable or unsafe path, an unavailable verified Harness, or a failure to save the new session prevents startup. Stage has no model-visible tools, confirmation gate, MCP tools, or automatic rewrite by default. If you later edit either source card, a resumed Stage session keeps its saved character and scene context and can show a source-drift notice.

Stage responses use the shared three-part packet. The player view keeps the prose primary, shows a compact status indicator, and hides complete opening logic comments and Neural Chain comments by default. Click a Stage assistant message to switch that message to its exact raw source, including every HTML-comment delimiter and HUD line; click again to return to the player view. A focused Stage message also supports Enter or Space. This view state is temporary, so resumed and rewound sessions begin in the player view while the raw packet remains unchanged in provider history and the session file.

## Switch an Engine

To switch future turns to Evaluate, submit:

```text
/engine evaluate
```

Vesicle should report that future turns will use the Evaluate profile. The command itself is local and does not call the provider.

Return to ETL after the exercise:

```text
/engine etl
```

An engine switch keeps the current conversation context by default. In an existing session, Vesicle records the transition and provides a bounded handoff packet to future provider turns. This helps the next engine understand why control changed, but it does not rewrite earlier messages.

Use an engine switch when the same project genuinely moves to another Prism task. For an unrelated task, starting a fresh session first is usually clearer; Chapter 08 teaches `/new`.

Advanced forms such as `/engine <id> --summary` and model-requested engine handoffs are covered in later chapters.

## Choose the Right Layer

- Switch the **provider** when you need a different API service or account.
- Switch the **model** when you need different intelligence, speed, price, context, reasoning, or vision capabilities.
- Switch the **engine** when the work changes from extraction to evaluation, runtime interaction, weaving, orchestration, or another Prism workflow.

If an engine requires tools or capabilities that the active model does not support, switch the model separately.

## Completion Check

You are ready when:

- you can explain why a model and an engine are different
- `/model` opens the two-step provider and model picker
- `/engine` lists bundled Prism engines and marks the active one; Stage starts only through `/stage`
- you know that `/stage` starts the seventh Engine from a character and scenario card
- you switched to `evaluate` and back to `etl` without making a provider request
- you understand that switches affect future turns and can be restored with a session
- `/agents` lists specialized profiles independently of the seven Prism engines
- you understand the difference between foreground waiting and background result delivery

[Next: Sessions and Resume →](./08-sessions-and-resume.md)
