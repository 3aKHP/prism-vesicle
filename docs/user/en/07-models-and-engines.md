# 07 — Models and Prism Engines

[← Previous: First conversation](./06-first-conversation.md) | [Manual index](./README.md) | [简体中文](../zh-CN/07-models-and-engines.md) | [Next: Sessions and resume →](./08-sessions-and-resume.md)

## What You Will Accomplish

You will understand the difference between a provider, a model, and a Prism engine; inspect the configured choices; and switch models or engines without confusing their responsibilities.

**Estimated time:** 15 minutes

**Prerequisites:** Chapters 00–06 and a working Vesicle installation

## Three Different Layers

Vesicle brings three separate choices together:

| Layer | What it controls | Example |
|---|---|---|
| Provider | The remote service, endpoint, account, and API key | DeepSeek |
| Model | The specific AI model, capabilities, limits, and usage price | `deepseek-v4-flash` |
| Prism engine | The workflow instructions, tools, validators, and confirmation gates | `etl` |

Changing the model changes which AI performs future requests. Changing the Prism engine changes what that AI is instructed to do. An engine is not a model, and switching engines does not move your account to another provider.

## Inspect the Active Provider and Model

The TUI footer shows the active provider and model. You can also open the model picker by submitting:

```text
/model
```

The picker has two steps:

1. Use Up and Down to choose a configured provider, then press Enter.
2. Choose one of that provider's configured models, then press Enter again.

Ctrl+P and Ctrl+N are alternatives to Up and Down. Escape returns from the model step to the provider step; pressing Escape again closes the picker without changing anything.

The Chapter 04 beginner configuration contains only one provider and one model, so the picker may have only one choice at each step. Later, after additional profiles are added to `providers.yaml`, the same picker becomes the safest way to switch.

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

The current alpha has different levels of validation and confirmation support across these engines. `STATUS.md` is the authority for current limitations; do not assume that every engine has the same validators or guided workflow.

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
- `/engine` lists six bundled Prism engines and marks the active one
- you switched to `evaluate` and back to `etl` without making a provider request
- you understand that switches affect future turns and can be restored with a session

[Next: Sessions and Resume →](./08-sessions-and-resume.md)
