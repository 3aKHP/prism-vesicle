# First conversation: interface and gates

English | [简体中文](../../zh-CN/tutorials/first-conversation.md)

This page introduces the Vesicle interface and its core interaction — the **gate**: at key points the engine pauses and waits for your confirmation before continuing. By the end you can read a full turn.

## Prepare some material

Vesicle uses the ETL engine by default; it turns your source material into character cards and scenario cards. Put one note in the project first:

```bash
mkdir -p source_materials
cat > source_materials/note.md <<'EOF'
# Character sketch: Lin Yue (林越)
28, former war correspondent, now runs a late-night café. Quiet, extremely observant.
An old scar on the left wrist. Writes important things on paper cups.
EOF
```

## Start and send your first message

Make sure you are in the project directory:

```bash
vesicle .
```

The screen has a few areas: the **conversation area** on top, the **workspace** list on the side, and the **input box** at the bottom.

Write your intent in the input box and press Enter:

> Read source_materials/note.md and give me a character concept draft based on Lin Yue.

Input box conventions:

- Enter = send while idle; queue ordinary messages and deferred commands while the Agent Loop is running.
- Ctrl+Enter = newline (for multi-line input).
- Esc = interrupt the current provider or tool operation and process the next queued input immediately.

You can keep writing ordinary messages or commands while the Agent Loop runs. Enter places deferred input in the FIFO shown above the composer. Vesicle injects queued messages after the current complete tool round and before the next provider request. Safe host-only commands can run immediately; artifact reads wait for the tool round; configuration, picker, and session commands wait for the Agent Loop. If the loop finishes first, the next queued input is processed immediately. With an empty composer, Up retrieves the latest queued input for editing.

The engine reads the material, then produces a **blueprint** in the conversation area (Target Concept, Archetype, Core Desire, and so on). Nothing is written to a file in this step.

## Gates: it pauses for your call

After the blueprint, the engine does **not** keep writing on its own — a confirmation panel appears at the bottom, usually with two choices: **Confirm** / **Reject**. That is a "gate".

- Pick **Confirm** — the engine moves to the next phase.
- Pick **Reject** (an empty rejection is fine) — the engine asks what to change, then comes back.

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
- `/artifact` — list generated artifacts.
- `/engine` — show the active engine (ETL by default).
- Ctrl+Q — exit Vesicle.

## Checklist

- [ ] You sent a prompt and received a blueprint.
- [ ] You confirmed or rejected at a gate.
- [ ] You ran `/context` to see usage.

You now have the rhythm of "turn + gate". Next, learn how to [keep working during a turn](./work-while-running.md), then build a full card.
