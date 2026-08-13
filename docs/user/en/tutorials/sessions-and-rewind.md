# Sessions and rewind

English | [简体中文](../../zh-CN/tutorials/sessions-and-rewind.md)

Vesicle persists every conversation inside the project, so you can return to old sessions any time, and within a session you can **rewind** to any step and rewrite. This page covers two things: cross-session resume, and in-session rewind.

## Where sessions live

Every project directory has a `.vesicle/`:

- `.vesicle/sessions/` — session records (append-only JSONL): each turn's user input, model reply, tool calls, gate decisions, usage, and more.
- `.vesicle/file-history/` — checkpoints of files changed by Vesicle tools (one per real user turn).

Sessions belong to the project and follow the project directory; a different machine or a different project directory is a different set of sessions.

## Resume an old session

Before entering Vesicle, you can open the session picker directly from the project directory:

```bash
vesicle --resume .
```

The short form is `vesicle -r .`. No provider request starts before you select a session.

When Vesicle is already open, enter:

```
/resume
```

Opens a list of this project's past sessions (by time); pick one to resume. You can also `/resume 2` or `/resume <session-id>`. Resume restores the conversation, any unresolved gates, the model selection, and more.

To start fresh instead of resuming:

```
/new
```

## Rewind: return to any step

`/rewind` (alias `/checkpoint`) opens a **rewind picker** that lists every prompt you have sent in this session. Pick one:

- The conversation is **restored to just before that prompt**, and the prompt is refilled into the input box so you can edit and resend.
- The old branch **is not deleted**, so you can explore freely.
- You can also choose whether to restore the files Vesicle changed in that turn; before confirming, it lists the affected files and the insertion/deletion counts.

Shortcut: with the input box **empty**, press Esc twice (within 800ms) to open the rewind picker directly.

> The rewind file checkpoints cover only files changed by Vesicle's own tools. Files you change by hand outside Vesicle are not in this ledger and are not rewind targets.

## Regenerate and switch candidates

Not happy with the last reply? Have it **try again**; the old version is kept, and you can switch between the two at any time — on the Chat page, press **Ctrl+R**.

Ctrl+R re-runs the **entire last turn** with the same prompt and produces a new reply as a new candidate. Once the re-run starts, the old reply is cleared from the screen and the new candidate streams in its place; the old candidate is not deleted, it just no longer occupies the view. Once the re-run finishes, a marker like `< 1/2 >` appears under the reply — use **Option+← / Option+→** to switch between candidates. On the Workspace page, `Ctrl+R` continues to reload the active file from disk instead:

- Switching only changes which version is shown and which one later messages build on; it does not call the model again.
- On the chat-only Stage engine a regenerate is cheap (a single model call); on file-writing authoring engines the whole workflow re-runs, which costs more.

> **About files**: regenerate does **not** switch the files Vesicle wrote between candidates yet. The Stage engine writes no files, so it is unaffected; but authoring engines (which write chapter and setting files) generate the new candidate on top of the files the previous candidate left behind, and switching back to an older candidate does not switch the files back either. Full "files switch with the candidate" support is coming in a later release.

> Each regenerate and each switch appends to the session record, and old candidates are kept forever. The session file grows and loads more slowly as candidates accumulate; Vesicle does not clean this up automatically — start a fresh session with `/new`, or delete unneeded files under `.vesicle/sessions/` by hand when you want to.

Regenerate runs only once the current turn has finished and there is no unresolved confirmation / permission / question and no background SubAgent still running; otherwise the status line tells you to resolve those first.

## When context gets long: compact

After a conversation grows, you can compact it into a summary and continue, saving context:

```
/compact
```

Optionally add instructions, e.g. `/compact keep the character card topology decisions`. Compaction produces a summary through the current model, then continues from the summary; the original text stays in the session record.

Switching engines can also compact on the way: `/engine <id> --summary`.

## Exit and interrupt

- Ctrl+Q — exit Vesicle (the session is already persisted; `/resume` finds it next time).
- Esc — abort a running request (already-written files are not lost).
- Double Esc with text in the input box — save the draft and clear it (without sending).

## Checklist

- [ ] You resumed an old session with `/resume`.
- [ ] You know that `vesicle --resume .` opens the session picker at startup.
- [ ] You rewound to a step with `/rewind` and resent a prompt.
- [ ] You know what `.vesicle/sessions/` and `.vesicle/file-history/` each store.

Next: [Set up Persistent Instructions](./persistent-instructions.md).
