# 06 — Complete Your First Conversation

[← Previous: Doctor and launch](./05-doctor-and-launch.md) | [Manual index](./README.md) | [简体中文](../zh-CN/06-first-conversation.md)

## What You Will Accomplish

You will send a safe first prompt, recognize the stages of a provider turn, use the basic composer controls, and confirm that the conversation is saved automatically.

**Estimated time:** 15 minutes

**Prerequisites:** Chapters 00–05, with Vesicle currently open

## Identify the Main Areas

Depending on terminal width, Vesicle may rearrange or hide secondary information. The important areas are:

- the conversation stream, where user and assistant messages appear
- the status or footer area, which shows the active provider, model, engine, and activity
- the composer at the bottom, where you type
- optional side information for artifacts, MCP tools, or session state

The layout may become simpler in a narrow window. This does not remove the underlying features.

## Send a Safe First Prompt

Click the terminal if necessary, type the following prompt into the bottom composer, and press Enter:

```text
Before we begin a project, explain in plain language what the active Prism ETL engine can help me create. Do not create or edit any files yet.
```

Vesicle sends the request to the configured provider. While it is working, the status text changes and response text may appear gradually.

The exact answer is not predetermined because it comes from the selected model. A successful turn ends with an assistant response rather than a provider or credential error.

## Understand What Happened

For this turn, Vesicle:

1. loaded the active ETL engine profile and prompt assets
2. combined them with your message and the available tool definitions
3. sent the request to the provider
4. streamed or displayed the response
5. appended the turn to the current session under `.vesicle/sessions/`

The instruction not to create files keeps the first turn easy to inspect. Later workflow chapters will deliberately allow artifact creation.

## Try the Composer Controls

Start typing a second message but do not submit it immediately.

- Backspace and Delete edit the draft.
- Ctrl+Enter inserts a newline inside the draft.
- Enter submits the complete draft.
- Up and Down move within a multiline draft before they recall older prompts.
- Escape during an active provider request cancels that request.

For practice, enter a two-line prompt with Ctrl+Enter between the lines:

```text
Give me three examples of source material that would help an ETL project.
Keep each example to one sentence and do not create files.
```

Press Enter to submit it.

## If Vesicle Asks a Question or Requests Confirmation

Prism engines can pause for user input. A panel may offer choices, an open-ended answer, Confirm, or Reject.

- Use the arrow keys to move between options.
- Follow the labels shown in the active panel to submit a choice.
- Confirm means the workflow may proceed past the described checkpoint.
- Reject returns feedback to the model; it does not mean the application failed.

The first explanatory prompts should not require file confirmation, but model behavior can vary. Read the panel summary before choosing.

## Inspect Context Without Calling the Provider

Type and submit:

```text
/context
```

This is a local Vesicle command. It reports available context and usage information without sending another model request. Some percentages appear only when the configured model declares context limits.

## Confirm Session Persistence

Press Ctrl+Q to exit Vesicle, then run `vesicle .` again from the same project folder. No global project pointer is involved.

Vesicle keeps session files under the project's `.vesicle` directory. A later manual chapter will explain `/resume`, session selection, and starting a clean session in detail.

## Completion Check

You have completed the beginner path when:

- at least one model response completed successfully
- you used Enter to submit and Ctrl+Enter to create a multiline draft
- you understand that Escape cancels an active request
- `/context` produced a local status message
- you know that sessions are saved under the project rather than in the provider configuration folder

You can now use Vesicle for exploratory conversations. Continue to follow the manual as later chapters are added before relying on file generation, engine handoff, rewind, external research, or MCP tools in important work.

[Next: Models and Prism Engines →](./07-models-and-engines.md)
