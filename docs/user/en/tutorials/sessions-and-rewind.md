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

### Resuming an old session after an upgrade: the migration confirm

Upgrading Vesicle can also update the bundled engine pack. Resuming a session recorded before such an update no longer fails outright; instead a one-time **migration confirmation panel** appears, first showing an offline check report (whether the engine still exists, whether a paused gate can still resolve, whether the conversation can still be sent to your current provider as-is, and whether the context is near its limit). You confirm twice before anything changes. The check itself never sends a provider request.

- After confirming: the session's full transcript is first **archived** under `.vesicle/sessions/archive/`, then the session continues under the new engine pack. Every later resume of this session shows a "recorded under an older engine pack" notice — the switch is never silent.
- If the report lists a red `✗` item (for example, the engine the session used no longer exists): the migration is refused, the session stays untouched, and you can start a new session instead.
- `⚠` items (context near the limit, changed Skills, and so on) allow the migration; the consequences are listed in the report.

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

- Switching changes which version is shown, which one later messages build on, and which files are on disk; it does not call the model again.
- On the chat-only Stage engine a regenerate is cheap (a single model call); on file-writing authoring engines the whole workflow re-runs, which costs more.

> **About files**: the files Vesicle wrote switch with the candidate. When a candidate is left, **every file** under the content roots (`source_materials/`, `workspace/`, `novels/`, `reports/`, `test_runs/`) is snapshotted into that candidate's full file manifest; switching candidates makes the disk strictly equal to the selected candidate's manifest — entries in it restore, paths outside it are deleted. Manual edits and MCP-tool writes made while a candidate is active are therefore snapshotted too, and deleted or restored along with everything else on switch. Regenerate re-runs the turn against the files as they were when the turn first started. The Stage engine writes no files, so it is unaffected. Some content stays outside authoritative restoration, as with `/rewind`: host processes (`shell_exec` / skill scripts — Vesicle warns you when a candidate is affected) only produce a warning, the scratch `tmp/` root stays outside manifests, and symbolic links and special files are kept as-is — never restored, never deleted (recorded as `untracked` in the switch outcome). Candidates created before this upgrade and never left since carry old-format file snapshots that are no longer read; switching to them changes the conversation only, and Vesicle says so in the status line.

> Each regenerate and each switch appends to the session record, and old candidates are kept forever. The session file grows and loads more slowly as candidates accumulate; Vesicle does not clean this up automatically — start a fresh session with `/new`, or delete unneeded files under `.vesicle/sessions/` by hand when you want to.

Regenerate runs only once the current turn has finished and there is no unresolved confirmation / permission / question and no background SubAgent still running; otherwise the status line tells you to resolve those first. Switching candidates is likewise paused while a background SubAgent is running or queued, so its file writes cannot race the switch.

## The candidate tree: browse and switch branches at any depth

The inline `< n/m >` switcher only covers the last turn. To return to an earlier fork — even one whose candidates were continued and forked again afterwards — use the **`/branch`** command or **Ctrl+B** (works on both the Chat and Workspace pages):

- The panel renders **every** fork point and candidate in the session, including subtrees inside branches that are no longer active; the current active path is expanded by default and marked with `●`.
- `↑/↓` move, `←/→` fold/unfold, `Enter` selects a candidate, `Esc` (or Ctrl+B again) closes the panel.
- Selecting a candidate opens a **confirm step**: a read-only preview of the file changes first (which files change, `+/-` line counts), then the conversation and disk switch only after you confirm. The confirm step warns about missing file state and host-process taint. After the switch, the active branch moves to the selected candidate; turns that came after it stay in the session but leave the active path.
- Press `r` on a fork row to **regenerate that turn** (equivalent to Ctrl+R on a historical turn); later turns leave the active path.
- Switching follows the same constraints as the inline switcher: refused while busy or while a background SubAgent is running; files move before the selection marker.

> Ctrl+B used to be the composer's Emacs backward-char key; it now opens the candidate tree instead. Bare `←` cursor movement and `Meta+b` word movement are unaffected.

## Message focus: Alt+↑ / Alt+↓

**Alt+↑ / Alt+↓** moves a **turn-level focus cursor** across the whole transcript (every engine): each press stops on the previous/next turn's prompt and final reply, wrapping at the edges; the focused messages are highlighted in the brand color and scrolled into view. When the focus lands on a Stage message, **Ctrl+Alt+S** still expands/collapses it. With the cursor on a turn, **Ctrl+R regenerates that turn** (without a focus it still regenerates the last turn).

**Alt+← / Alt+→** performs candidate switching first; when the current turn has no switchable candidates, Vesicle no longer stays silent — the status line guides you: Ctrl+B opens the candidate tree when the focused turn has candidates, otherwise Ctrl+R regenerates that turn.

## When context gets long: compact

After a conversation grows, you can compact it into a summary and continue, saving context:

```
/compact
```

Optionally add instructions, e.g. `/compact keep the character card topology decisions`. Compaction produces a summary through the current model, then continues from the summary; the original text stays in the session record.

Success adds `Conversation compacted into a summary` to the transcript and reports how many messages were compacted in the status line. `/context` then shows lower current occupancy and checkpoint information. Compaction is a real provider request. If the provider fails or you cancel with Esc, the old context and input draft remain; Vesicle does not install half a checkpoint. Fix the connection and retry, or switch to an available model first.

### Optional automatic compaction

Automatic compaction is **off by default**. The current model entry in `providers.yaml` must declare both a valid `limits.contextWindow` and `limits.autoCompact`, for example:

```yaml
limits:
  contextWindow: 128000
  maxOutputTokens: 8192
  autoCompact:
    enabled: true
    threshold: 0.85
    reserveOutputTokens: 8192
```

Once enabled, Vesicle checks the projected complete next request before a top-level input and at safe boundaries in a long tool loop. Queued input, background completion notices, and tool schemas count. On trigger the status moves through compaction and finishes with `compacted <N> units`. `/context` reports active/inactive state, soft trigger, hard limit, and output-reserve source; use it to confirm configuration really took effect.

If automatic compaction fails at the soft trigger, Vesicle shows a warning and may continue the current request. The send is blocked and your draft is preserved only when projected input **strictly exceeds** the hard ceiling; equality remains sendable. Run `/context`, then use manual `/compact`, switch to a larger-context model, or reduce the input. A pending gate, Engine switch, question, permission, or quality decision defers compaction; resolve the bottom panel first. See [Configuration files](../reference/configuration.md) for exact fields.

Switching engines can also compact on the way: `/engine <id> --summary`.

## Exit and interrupt

- Ctrl+Q — exit Vesicle (the session is already persisted; `/resume` finds it next time).
- Esc — abort a running request (already-written files are not lost); it also interrupts busy windows such as the approval step after a permission prompt, leaving an unfinished approval pending again.
- Double Esc with text in the input box — save the draft and clear it (without sending).

## Checklist

- [ ] You resumed an old session with `/resume`.
- [ ] You know that `vesicle --resume .` opens the session picker at startup.
- [ ] You rewound to a step with `/rewind` and resent a prompt.
- [ ] You inspected compaction state with `/context` and know automatic compaction is off by default.
- [ ] You know what `.vesicle/sessions/` and `.vesicle/file-history/` each store.

Next: [Set up Persistent Instructions](./persistent-instructions.md).
