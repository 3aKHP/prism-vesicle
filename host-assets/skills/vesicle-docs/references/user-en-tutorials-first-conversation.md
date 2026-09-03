<!-- Generated from docs/user/en/tutorials/first-conversation.md — do not edit. -->

# First conversation: interface and gates

English | [简体中文](../../zh-CN/tutorials/first-conversation.md)

This page introduces the Vesicle interface and its core interaction — the **gate**: at key points the engine pauses and waits for your confirmation before continuing. By the end you can read a full turn.

## Prepare some material

Vesicle uses the ETL engine by default; it turns source material into character and scenario cards. First create a `source_materials/` folder inside the project. Use your system file manager, run `New-Item -ItemType Directory -Force source_materials` in PowerShell 7, or run `mkdir -p source_materials` on Linux / macOS / WSL.

Then run `vesicle .` and press `Ctrl+O` for Workspace. Select `source_materials/` in the file tree and press `a`. The create bar already contains `source_materials/`, so enter only `note.md` and press Enter. Fill the new file with the text below, then press `Ctrl+S`:

```markdown
# Character sketch: Lin Yue
Age 28, formerly a war correspondent, now running a late-night cafe. Quiet and highly observant.
An old scar crosses the left wrist. Important things get written on paper cups.
```

After the status line reports a successful save, press `Ctrl+O` to return to Chat. If you prefer the terminal, you can create both the folder and file there instead.

PowerShell 7:

```powershell
New-Item -ItemType Directory -Force source_materials | Out-Null
@'
# Character sketch: Lin Yue
Age 28, formerly a war correspondent, now running a late-night cafe. Quiet and highly observant.
An old scar crosses the left wrist. Important things get written on paper cups.
'@ | Set-Content -Encoding utf8 source_materials/note.md
```

Linux / macOS / WSL:

```bash
mkdir -p source_materials
cat > source_materials/note.md <<'EOF'
# Character sketch: Lin Yue (林越)
28, former war correspondent, now runs a late-night café. Quiet, extremely observant.
An old scar on the left wrist. Writes important things on paper cups.
EOF
```

Whichever path you use, the final file should be `source_materials/note.md` inside the project. If Workspace rejects the path, confirm Vesicle started at the intended project root and that the input is project-relative with no `..`.

## Start and send your first message

If Vesicle is not already open, start it from the project directory:

```bash
vesicle .
```

Vesicle has two top-level pages: Chat and Workspace. On Chat, the conversation is on top, the Host sidebar shows session, Agent, and artifact status, and the input box is at the bottom. Press `Ctrl+O` at any time to switch to the project-file workbench.

Write your intent in the input box and press Enter:

> Read source_materials/note.md and give me a character concept draft based on Lin Yue.

Input box conventions:

- Enter = send while idle; queue ordinary messages and deferred commands while the Agent Loop is running.
- Ctrl+Enter = newline (for multi-line input).
- Esc = interrupt the current provider or tool operation; after the interrupted session is rebuilt, the input captured as the FIFO head at the keypress is submitted once — only if it is still the queue head (with an empty queue, Esc only interrupts and leaves any draft untouched).

You can keep writing ordinary messages or commands while the Agent Loop runs. Enter places deferred input in the FIFO shown above the composer. Vesicle injects queued messages after the current complete tool round and before the next provider request. Safe host-only commands can run immediately; artifact reads wait for the tool round; configuration, picker, and session commands wait for the Agent Loop. If the loop finishes first, the next queued input is processed immediately. With an empty composer, Up retrieves the latest queued input for editing.

The engine reads the material, then produces a **blueprint** in the conversation area (Target Concept, Archetype, Core Desire, and so on). Nothing is written to a file in this step.

## Gates: it pauses for your call

After the blueprint, the engine does **not** keep writing on its own — a confirmation panel appears at the bottom, usually with two choices: **Confirm** / **Reject**. That is a "gate".

- Pick **Confirm** — the engine moves to the next phase.
- Pick **Reject** (an empty rejection is fine) — the engine asks what to change, then comes back.

Long gate summaries arrive folded (`▸ N lines folded`): press `Tab` to read the full text with `↑/↓`, and `Enter` there only returns to the choices — it never decides. Typing while **Confirm** is focused starts attaching a note to it.

> Gates are normal in Vesicle: the blueprint, every writing phase, and some tool calls pause for you. The point is to **keep you in control at every key node**, instead of letting the model write all the way to the end.

## Read the status bar

After a turn, the bottom shows that turn's usage, like `↑1.2k ↓340 ↻0` (upstream / downstream / cached tokens) and a context-occupancy percentage. For details:

```
/context
```

## Common commands

Commands start with `/` in the input box; typing `/` opens a candidate menu (↑↓ to choose, Tab/Enter to complete):

- `/help` — list all commands.
- `/context` — current context usage.
- `/artifact` — open generated artifacts in the Workspace page.
- `/workspace [path]` — open the project-file workbench and optionally locate a file.
- `/theme dark|light|default|auto` — switch the interface theme temporarily (`default` follows the terminal, `auto` follows the clock).
- `/engine` — show the active engine (ETL by default).
- Ctrl+Q — exit Vesicle.

## Checklist

- [ ] You sent a prompt and received a blueprint.
- [ ] You confirmed or rejected at a gate.
- [ ] You ran `/context` to see usage.

You now have the rhythm of "turn + gate". Next, [view and edit artifacts in the Workspace page](./workspace-page.md), then learn how to [keep working during a turn](./work-while-running.md).
