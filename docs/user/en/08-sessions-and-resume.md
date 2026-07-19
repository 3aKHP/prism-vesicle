# 08 — Sessions and Resume

[← Previous: Models and engines](./07-models-and-engines.md) | [Manual index](./README.md) | [简体中文](../zh-CN/08-sessions-and-resume.md)

## What You Will Accomplish

You will understand what a Vesicle session stores, start a fresh session without deleting history, resume an older session, and recognize pending work in the session picker.

**Estimated time:** 20 minutes

**Prerequisites:** Chapters 00–07 and at least one completed conversation

## What a Session Is

A session is the durable record of one conversation and its host state. Vesicle stores sessions as append-only JSONL files under the current project:

```text
.vesicle\sessions\
```

A session can preserve:

- user, assistant, and tool messages
- the selected provider and model
- the active Prism engine
- thinking effort and reasoning display settings
- usage metadata and validation notices
- unresolved confirmation gates, engine-switch requests, user questions, or Output Quality Guard decisions

Do not edit session JSONL files by hand. Later chapters will explain supported rewind, backup, and recovery operations.

## Sessions Belong to a Project Folder

Vesicle finds `.vesicle\sessions` relative to the folder from which it is launched. If you start Vesicle from another project folder, you see that project's sessions instead.

Run `vesicle .` from the intended project directory. Session isolation follows that invocation directory, not a project saved by guided Setup.

This project-local behavior keeps unrelated work separate. Provider configuration remains user-level and can be shared across projects.

## One Active Session at a Time

One TUI run keeps one active session until you deliberately start or resume another one. Ordinary prompts continue the active conversation automatically; you do not need to save manually after every turn.

If Vesicle finds existing sessions at startup, it displays a notice suggesting `/resume`. Typing a normal prompt instead begins a new conversation rather than automatically choosing an old one.

## Start a Fresh Session

Submit:

```text
/new
```

Vesicle clears the active conversation and reports:

```text
Started a fresh session. Type a prompt to begin.
```

`/new` does not delete the previous session or its files. It also keeps the currently selected provider, model, and engine. The new session file is created when you submit the next real prompt.

For the exercise, send a short identifying prompt:

```text
This is my second practice session. Reply with one sentence confirming that you can read this message, and do not create files.
```

Wait for the response to finish.

## Open the Resume Picker

Submit:

```text
/resume
```

The picker lists sessions newest first. Each row includes a number, part of the session id, a conversation preview, and the record count.

- Use Up and Down, or Ctrl+P and Ctrl+N, to select a row.
- Press Enter to resume the selected session.
- Press Escape to close the picker without changing sessions.

Find the older session whose preview contains your first-conversation text, select it, and press Enter.

## What Resume Restores

After resume, Vesicle rebuilds the visible conversation and restores the latest valid session state. Host notices report the restored engine and, when available, the provider and model.

If the session refers to a provider or model that is no longer present in `providers.yaml`, Vesicle keeps the current valid selection and displays an explanation instead of inventing a configuration.

The resume picker can also mark interrupted interactions:

- `[gate:...]` means a confirmation gate is waiting.
- `[engine:...]` means an engine-switch request is waiting.
- `[question:...]` means a model question is waiting for an answer.
- `[quality:interrupted]` means an automatic quality revision was interrupted.
- `[quality:decision]` means automatic revision was exhausted and needs your decision.

Resuming such a session restores the relevant panel so you can continue rather than losing the pending decision.

The experimental Semantic Judge is off by default. `/quality` opens a picker for mode, registered provider, model, and rewrite confirmation; `/quality status` shows the current setting. You can also choose a separately configured provider and model with `/quality observe <provider> <model> [timeout-ms]`; `/quality rewrite <provider> <model> [timeout-ms]` first displays an explicit confirmation command. The settings live in user-level `quality.yaml` beside `providers.yaml`; they never contain an API key, URL, prompt, rules, or tool permissions. Advanced alpha testers can start from [`docs/examples/quality.yaml`](../../examples/quality.yaml).

When enabled, eligible Runtime or Stage prose receives an additional request through that selected Judge provider and model. The request has no tools and no ordinary conversation history, but it sends the current prose again and consumes additional provider tokens. `observe` records style findings without revision. The explicitly confirmed experimental `rewrite` mode can request up to two revisions through the original Engine, then rechecks the resulting post-image. This is not a calibrated production policy or an AI-authorship detector. Invalid, unavailable, timed-out, oversized, or changed-configuration checks are shown and saved as incomplete rather than clean; they do not block ordinary delivery.

For a quality decision, `Revise again` authorizes one additional provider request from the same Engine. `Use current version` and `Stop` do not call the provider; both keep the warning in the durable session record. If the required Harness, Rule Pack, or experimental Judge profile identity has changed, revision is unavailable until that exact identity is restored, but you can still use or stop the current version. A `!` beside an artifact in the Workspace sidebar marks a path whose quality warning remains visible. This status reports findings from the active rules, not whether text was written by AI and not a general guarantee of writing quality.

## Resume by Number or Id

The picker is the safest beginner method. Vesicle also supports:

```text
/resume 2
```

The number refers to the newest-first list produced by the current `/resume` command. Advanced users can also provide a unique session-id prefix. If a number or prefix does not match, Vesicle reports the problem without changing the active session.

## Inspect Session Files Safely

Exit Vesicle with Ctrl+Q. In PowerShell, list the session file names without opening or changing them:

```powershell
Get-ChildItem ".vesicle\sessions"
```

Each `.jsonl` file is one durable session record. Return to the same project directory and run `vesicle .` again afterward.

## Completion Check

You are ready when:

- you know that sessions are project-local and append-only
- `/new` starts a fresh conversation without deleting older sessions
- you created a second practice session
- `/resume` opened a newest-first picker and restored an older conversation
- you understand the pending gate, engine, question, and quality markers
- you can locate `.vesicle\sessions` without editing its files

The next chapter will use these session skills during a complete ETL workflow.

[Next: A Complete ETL Workflow →](./09-complete-etl-workflow.md)
